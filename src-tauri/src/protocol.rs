//! `vellum://` custom protocol (§4.3) — owned by B2.
//!
//! Route table (§4.3): `vellum://book/{uid}/chapter/{idx}`,
//! `vellum://book/{uid}/asset/{pct-encoded-path}`, `vellum://book/{uid}/cover`,
//! `vellum://covers/{uid}`, anything else → 404. All responses carry
//! `Access-Control-Allow-Origin: *`; `Cache-Control: no-cache` for chapters and
//! `max-age=86400` for assets/covers.
//!
//! Layering (so this is testable without a Tauri app):
//! - [`parse_vellum_uri`] — pure URI → [`Route`], no I/O.
//! - [`dispatch`] — [`Route`] + [`ProtocolCtx`] (db / zip cache / covers dir) → `http::Response`.
//!   Called directly by the unit tests in `tests/b2_protocol.rs`.
//! - [`uri_scheme_protocol`] — the `Send + Sync + 'static` closure handed to
//!   `tauri::Builder::register_asynchronous_uri_scheme_protocol`. See the FROZEN-CHANGE-REQUEST in
//!   the B2 report: Tauri 2.11 exposes protocol registration **only** on `Builder`, and its
//!   `setup()` creates the config windows *before* running the setup hook, so `register(&AppHandle)`
//!   from inside `.setup()` has no API to call and is too late anyway.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{AppHandle, UriSchemeContext, UriSchemeResponder, Wry};

use crate::epub::serve::{self, Served, ZipCache};

/// Cover-file extensions probed in `covers_dir` (§4.8 writes `{uid}.{ext}`).
const COVER_EXTS: [&str; 7] = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];

/// A parsed `vellum://` request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// `vellum://book/{uid}/chapter/{idx}`
    Chapter { uid: String, idx: usize },
    /// `vellum://book/{uid}/asset/{pct-encoded-path}` — `path` is the decoded zip entry.
    Asset { uid: String, path: String },
    /// `vellum://book/{uid}/cover`
    BookCover { uid: String },
    /// `vellum://covers/{uid}`
    Covers { uid: String },
    /// Anything else.
    NotFound,
}

/// Everything [`dispatch`] needs; borrowed so tests can supply a temp DB + temp zip cache.
pub struct ProtocolCtx<'a> {
    /// `AppState::db` — locked only for the two tiny lookups, never across I/O.
    pub db: &'a Mutex<rusqlite::Connection>,
    /// `AppState::zips`.
    pub zips: &'a ZipCache,
    /// `AppState::paths.covers_dir`.
    pub covers_dir: &'a Path,
}

/// Parse a raw `vellum://` URI into a [`Route`].
///
/// WebKit lowercases the authority but preserves path case and percent-encoding verbatim, and
/// `http::Uri` exposes no fragment accessor — so the string is split by hand and the query and
/// fragment are dropped before any decoding.
///
/// Two authority shapes are accepted because the route kind can arrive either as the host
/// (`vellum://book/{uid}/…`, what rewritten chapter markup produces) or as the first path segment
/// behind a `localhost` host (`vellum://localhost/book/{uid}/…`, the origin shape Tauri reports for
/// custom schemes on Linux). Both resolve identically.
pub fn parse_vellum_uri(uri: &str) -> Route {
    // 1. scheme
    let rest = match strip_scheme(uri, "vellum://") {
        Some(r) => r,
        None => return Route::NotFound,
    };
    // 2. drop fragment, then query (fragment may precede or follow '?' in practice)
    let rest = rest.split('#').next().unwrap_or("");
    let rest = rest.split('?').next().unwrap_or("");

    // 3. authority = up to the first '/'
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let authority = authority.to_ascii_lowercase();

    // 4. segment list, skipping empties from leading/duplicate/trailing slashes
    let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    // Normalize the `localhost`-host shape into (kind, params).
    let (kind, params): (&str, &[&str]) = if authority == "localhost" {
        match segs.split_first() {
            Some((first, tail)) => (first, tail),
            None => return Route::NotFound,
        }
    } else {
        (&authority, &segs[..])
    };
    // Route kinds are case-insensitive (a host is); uids and paths are not.
    let kind = kind.to_ascii_lowercase();

    match kind.as_str() {
        "book" => parse_book_route(params),
        "covers" => match params.first() {
            Some(uid) if !uid.is_empty() => Route::Covers {
                uid: uid.to_string(),
            },
            _ => Route::NotFound,
        },
        _ => Route::NotFound,
    }
}

/// `{uid}/chapter/{idx}` | `{uid}/asset/{path…}` | `{uid}/cover`.
///
/// Never slices `params` directly: a short route (`vellum://book`, `vellum://book/{uid}`) is a
/// legitimate 404, not a panic. This runs on the protocol's main-thread callback.
fn parse_book_route(params: &[&str]) -> Route {
    let (Some(&uid), Some(&kind)) = (params.first(), params.get(1)) else {
        return Route::NotFound;
    };
    if uid.is_empty() {
        return Route::NotFound;
    }
    let tail: &[&str] = params.get(2..).unwrap_or(&[]);
    match kind.to_ascii_lowercase().as_str() {
        "chapter" => match tail.first() {
            // A trailing slash or a non-numeric index must not match a chapter.
            Some(idx) if tail.len() == 1 => match idx.parse::<usize>() {
                Ok(n) => Route::Chapter {
                    uid: uid.to_string(),
                    idx: n,
                },
                Err(_) => Route::NotFound,
            },
            _ => Route::NotFound,
        },
        "asset" => {
            if tail.is_empty() {
                return Route::NotFound;
            }
            // Decode segment-wise: the encoder preserves '/' separators and escapes everything
            // else, so a round-trip through `pct_encode_path` lands back on the zip entry name.
            let decoded: Vec<String> = tail.iter().map(|s| pct_decode(s)).collect();
            let path = decoded.join("/");
            if path.is_empty() {
                return Route::NotFound;
            }
            Route::Asset {
                uid: uid.to_string(),
                path,
            }
        }
        "cover" if tail.is_empty() => Route::BookCover {
            uid: uid.to_string(),
        },
        _ => Route::NotFound,
    }
}

/// Case-insensitive prefix strip (the scheme is normalized to lowercase by the URL parser, but a
/// hand-built request may not be).
fn strip_scheme<'a>(uri: &'a str, scheme: &str) -> Option<&'a str> {
    let bytes = uri.as_bytes();
    if bytes.len() < scheme.len() {
        return None;
    }
    if !bytes[..scheme.len()].eq_ignore_ascii_case(scheme.as_bytes()) {
        return None;
    }
    Some(&uri[scheme.len()..])
}

/// Percent-decode one path segment (invalid escapes pass through verbatim).
fn pct_decode(s: &str) -> String {
    crate::epub::rewrite::pct_decode(s)
}

/// Build the response for `route`. Runs on a worker thread — blocking I/O and mutexes are fine.
pub fn dispatch(route: Route, ctx: &ProtocolCtx<'_>) -> Response<Vec<u8>> {
    match route {
        Route::NotFound => not_found(),
        Route::Chapter { uid, idx } => {
            // Two tiny queries, strings cloned out, lock dropped before any zip I/O (§11.3).
            let Some((book_path, entry)) = lookup_chapter(ctx.db, &uid, idx) else {
                return not_found();
            };
            respond(serve::serve_chapter_entry(
                &uid, &book_path, &entry, ctx.zips,
            ))
        }
        Route::Asset { uid, path } => {
            let Some(book_path) = lookup_book_path(ctx.db, &uid) else {
                return not_found();
            };
            respond(serve::serve_asset_entry(&uid, &book_path, &path, ctx.zips))
        }
        Route::BookCover { uid } => {
            // Cheap path first: the extracted cover file B3 wrote at import time. This also keeps
            // covers working while B1's `find_cover_href` is still a stub.
            if let Some(file) = find_cover_file(ctx.covers_dir, &uid) {
                return respond_cover_file(&file);
            }
            let Some(book_path) = lookup_book_path(ctx.db, &uid) else {
                return not_found();
            };
            respond(serve::serve_cover(&uid, &book_path, ctx.zips))
        }
        Route::Covers { uid } => match find_cover_file(ctx.covers_dir, &uid) {
            Some(file) => respond_cover_file(&file),
            None => not_found(),
        },
    }
}

/// `SELECT path FROM books WHERE uid=?` — short lock, string cloned out.
fn lookup_book_path(db: &Mutex<rusqlite::Connection>, uid: &str) -> Option<String> {
    let conn = db.lock().ok()?;
    conn.query_row("SELECT path FROM books WHERE uid=?1", [uid], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

/// `books.path` + `chapters.href` for one spine index.
fn lookup_chapter(
    db: &Mutex<rusqlite::Connection>,
    uid: &str,
    idx: usize,
) -> Option<(String, String)> {
    let conn = db.lock().ok()?;
    let book_path = conn
        .query_row("SELECT path FROM books WHERE uid=?1", [uid], |r| {
            r.get::<_, String>(0)
        })
        .ok()?;
    let href = conn
        .query_row(
            "SELECT href FROM chapters WHERE book_uid=?1 AND idx=?2",
            rusqlite::params![uid, idx as i64],
            |r| r.get::<_, String>(0),
        )
        .ok()?;
    Some((book_path, href))
}

/// `{covers_dir}/{uid}.{ext}` for the first extension that exists.
fn find_cover_file(covers_dir: &Path, uid: &str) -> Option<PathBuf> {
    if uid.is_empty() || uid.contains('/') || uid.contains("..") {
        return None;
    }
    COVER_EXTS
        .iter()
        .map(|ext| covers_dir.join(format!("{uid}.{ext}")))
        .find(|p| p.is_file())
}

/// Serve a cached cover file from disk with the mime implied by its extension.
fn respond_cover_file(path: &Path) -> Response<Vec<u8>> {
    let body = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return not_found(),
    };
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    respond(Served::Ok {
        body,
        mime: serve::mime_for(name).to_owned(),
        cache_secs: serve::ASSET_CACHE_SECS,
    })
}

/// `Served` → `http::Response` with the §4.3 CORS + cache headers.
fn respond(served: Served) -> Response<Vec<u8>> {
    match served {
        Served::NotFound => not_found(),
        Served::Ok {
            body,
            mime,
            cache_secs,
        } => {
            let cache = if cache_secs == 0 {
                "no-cache"
            } else {
                // Static per §4.3; avoids a format! on every asset response.
                "max-age=86400"
            };
            build(StatusCode::OK, &mime, cache, body)
        }
    }
}

/// 404 with an empty body (§4.3).
fn not_found() -> Response<Vec<u8>> {
    build(
        StatusCode::NOT_FOUND,
        "text/plain;charset=utf-8",
        "no-cache",
        Vec::new(),
    )
}

/// Assemble one response. Header building cannot fail for these constant/static values, but a
/// builder error must not panic on a worker thread (that would strand the responder and hang the
/// request), so it degrades to a bare 404.
fn build(status: StatusCode, mime: &str, cache_control: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    let len = body.len();
    let result = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, cache_control)
        .body(body);
    result.unwrap_or_else(|_| {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Vec::new())
            .expect("constant-header 404 response builds")
    })
}

/// The handler closure for `Builder::register_asynchronous_uri_scheme_protocol("vellum", …)`.
///
/// Must be chained on the Builder **before** `.setup()`: Tauri creates the config windows at the
/// top of its own `setup()` and a scheme registered afterwards never reaches that webview.
///
/// The callback itself runs on the GTK main thread, so all work — the two DB lookups, the zip
/// read, the lol_html rewrite — is moved onto a blocking-pool task; `UriSchemeResponder` is `Send`.
pub fn uri_scheme_protocol(
) -> impl Fn(UriSchemeContext<'_, Wry>, Request<Vec<u8>>, UriSchemeResponder) + Send + Sync + 'static
{
    move |ctx: UriSchemeContext<'_, Wry>,
          request: Request<Vec<u8>>,
          responder: UriSchemeResponder| {
        // Parse on the main thread: it is pure string work, no I/O.
        let route = parse_vellum_uri(&request.uri().to_string());
        if matches!(route, Route::NotFound) {
            responder.respond(not_found());
            return;
        }
        let app = ctx.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            use tauri::Manager;
            // `app` is owned by this closure, so the `State` guard it borrows lives long enough
            // for `dispatch` — no lifetime games, no unsafe.
            let response = match app.try_state::<crate::AppState>() {
                Some(state) => {
                    let proto = ProtocolCtx {
                        db: &state.db,
                        zips: &state.zips,
                        covers_dir: &state.paths.covers_dir,
                    };
                    dispatch(route, &proto)
                }
                // State is managed during setup; a request before that point is a 404, not a panic.
                None => not_found(),
            };
            responder.respond(response);
        });
    }
}

/// Wire the `vellum` URI scheme handler onto the app. Called from `lib.rs` setup.
///
/// NOTE (FROZEN-CHANGE-REQUEST, see the B2 report): Tauri 2.11 has no protocol-registration API on
/// `AppHandle` — only `Builder::register_asynchronous_uri_scheme_protocol`, which consumes the
/// builder and must run before `.setup()`. This function therefore cannot register anything and
/// only logs; the app needs the one-line Builder change to make `vellum://` live.
pub fn register(_app: &AppHandle) {
    println!(
        "[vellum] protocol::register called from setup, but Tauri 2 registers URI schemes on the \
         Builder only. Add `.register_asynchronous_uri_scheme_protocol(\"vellum\", \
         protocol::uri_scheme_protocol())` to the Builder chain in lib.rs before `.setup(..)`; \
         until then vellum:// requests 404."
    );
}
