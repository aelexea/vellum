//! Frozen error convention (§4.2).
//!
//! Every Tauri command returns `CmdResult<T>`. [`AppError`] is a newtype over `String`
//! that serializes to its inner string, so the frontend receives a plain message it can
//! hand straight to `uiStore.toast(msg, 'error')`.

use std::fmt;

/// Application error surfaced to the frontend as its string payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError(pub String);

impl AppError {
    /// Convenience constructor.
    pub fn msg<S: Into<String>>(s: S) -> Self {
        AppError(s.into())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

/// §4.2: "serde-serializes as its string" — the frontend receives a bare string, not
/// `{ "0": … }`. Required because Tauri command errors must implement `Serialize`.
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

/// Tauri command result alias used crate-wide.
pub type CmdResult<T> = Result<T, AppError>;

// ---------------------------------------------------------------------------
// From impls: anything fallible in the backend collapses into AppError.
// ---------------------------------------------------------------------------

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError(format!("{e:#}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        AppError(e.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<std::string::FromUtf8Error> for AppError {
    fn from(e: std::string::FromUtf8Error) -> Self {
        AppError(e.to_string())
    }
}

impl From<String> for AppError {
    fn from(e: String) -> Self {
        AppError(e)
    }
}

impl From<&str> for AppError {
    fn from(e: &str) -> Self {
        AppError(e.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_shows_inner_string() {
        let e = AppError::msg("File unavailable");
        assert_eq!(e.to_string(), "File unavailable");
        assert_eq!(e.0, "File unavailable");
    }

    #[test]
    fn serializes_as_bare_string() {
        let json = serde_json::to_string(&AppError::msg("boom")).expect("serialize");
        assert_eq!(json, "\"boom\"");
    }

    #[test]
    fn from_io_error_preserves_message() {
        let io = std::io::Error::new(std::io::ErrorKind::NotFound, "nope");
        let e = AppError::from(io);
        assert!(e.0.contains("nope"), "got {e}");
    }

    #[test]
    fn from_serde_json_error() {
        let bad = serde_json::from_str::<u8>("not a number").unwrap_err();
        let e = AppError::from(bad);
        assert!(!e.0.is_empty());
    }
}
