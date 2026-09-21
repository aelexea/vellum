//! Reading sessions + aggregates (§3, §4.4) — owned by B4.
//!
//! `sessions` holds one row per (book, local day); `record_tick` upserts today's row.
//! Aggregates are computed on read — the table is tiny (one row per book per day), so no
//! materialised rollups (§1: local-first, minimal).
//!
//! Day strings are `yyyy-mm-dd`. Zero-padded ISO dates compare **lexicographically** in the
//! same order as chronologically, so every range filter is a plain `day >= ?` string
//! comparison and needs no date type in SQL.
//!
//! Date math (no chrono — §11.3) is done on *day indices* (days since 1970-01-01) with
//! Hinnant's civil-calendar algorithms, anchored on `db::today_str()`. Anchoring on the same
//! helper `record_tick` writes keeps reads and writes on one definition of "today"
//! (currently UTC per the scaffold note in `db/mod.rs`; B3 may switch it to local), and
//! day-index stepping is immune to DST 23 h/25 h days.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::today_str;
use crate::dto::{BookStats, DaySeconds, ReadingStats};

/// A day counts towards the streak only with at least this many seconds (§4.8 get_stats).
pub const READING_DAY_SECONDS: i64 = 60;

/// Ranges accepted by `get_stats` (§4.8). Unknown strings fall back to [`Range::All`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    /// Today only — always exactly one row.
    Day,
    /// Last 7 days including today, zero-filled.
    Week,
    /// Last 30 days including today, zero-filled.
    Month,
    /// Only days that actually have data, capped at the last 365 days.
    All,
}

impl Range {
    /// Parse the JS-side range string; case-insensitive, unknown → `All`.
    pub fn parse(s: &str) -> Range {
        match s.trim().to_ascii_lowercase().as_str() {
            "day" | "today" => Range::Day,
            "week" => Range::Week,
            "month" => Range::Month,
            _ => Range::All,
        }
    }

    /// Number of calendar days in the window (today inclusive), or `None` for `All`
    /// (window bounded by [`ALL_CAP_DAYS`] but rows only for days with data).
    fn days(self) -> Option<i64> {
        match self {
            Range::Day => Some(1),
            Range::Week => Some(7),
            Range::Month => Some(30),
            Range::All => None,
        }
    }
}

/// `all` never walks more than this many days back (§4.8 get_stats).
const ALL_CAP_DAYS: i64 = 365;

/// Upsert today's session row: `seconds += s`, `pages_turned += p` (UNIQUE(book_uid, day)).
///
/// Clamping of absurd heartbeat values happens in the command layer
/// (`commands::stats::clamp_tick`); this stores exactly what it is given.
pub fn record_tick(
    c: &Connection,
    uid: &str,
    seconds: i64,
    pages_turned: i64,
) -> anyhow::Result<()> {
    c.execute(
        "INSERT INTO sessions(book_uid, day, seconds, pages_turned) VALUES(?1, ?2, ?3, ?4) \
         ON CONFLICT(book_uid, day) DO UPDATE SET \
           seconds = seconds + excluded.seconds, \
           pages_turned = pages_turned + excluded.pages_turned",
        params![uid, today_str(), seconds, pages_turned],
    )?;
    Ok(())
}

/// Aggregate over `range` ∈ day|week|month|all (§4.8 get_stats).
///
/// `by_day` is oldest-first and zero-filled for fixed windows (day/week/month); `all`
/// returns only days that have rows. `range_seconds`, `pages_turned` and `books_touched`
/// cover the same window as `by_day`. `streak_days` is **not** windowed — it is a property
/// of the whole history, so the "Streak" tile survives a range switch (§5.8).
pub fn get_stats(c: &Connection, range: &str) -> anyhow::Result<ReadingStats> {
    get_stats_for(c, range, today_day_index())
}

/// `get_stats` with an injectable "today" (tests seed history relative to a fixed day).
fn get_stats_for(c: &Connection, range: &str, today_idx: i64) -> anyhow::Result<ReadingStats> {
    let range = Range::parse(range);
    // Inclusive window [from, today].
    let from_idx = today_idx - range.days().unwrap_or(ALL_CAP_DAYS) + 1;
    let from = day_string(from_idx);
    let to = day_string(today_idx);

    // Per-day sums across all books.
    let mut sums: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = c.prepare(
            "SELECT day, SUM(seconds), SUM(pages_turned) FROM sessions \
             WHERE day >= ?1 AND day <= ?2 GROUP BY day",
        )?;
        let rows = stmt.query_map(params![from, to], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (day, seconds, pages) = row?;
            sums.insert(day, (seconds, pages));
        }
    }

    let pages_turned: i64 = sums.values().map(|(_, p)| p).sum();
    let range_seconds: i64 = sums.values().map(|(s, _)| s).sum();

    // by_day: zero-filled window for day/week/month, present-days-only for `all`.
    let by_day = match range.days() {
        Some(n) => (0..n)
            .map(|back| {
                let idx = today_idx - (n - 1 - back);
                let date = day_string(idx);
                let seconds = sums.get(&date).map(|(s, _)| *s).unwrap_or(0);
                DaySeconds { date, seconds }
            })
            .collect(),
        None => {
            let mut days: Vec<String> = sums.keys().cloned().collect();
            days.sort();
            days.into_iter()
                .map(|date| DaySeconds {
                    seconds: sums.get(&date).map(|(s, _)| *s).unwrap_or(0),
                    date,
                })
                .collect()
        }
    };

    let books_touched: i64 = c
        .query_row(
            "SELECT COUNT(DISTINCT book_uid) FROM sessions \
             WHERE seconds > 0 AND day >= ?1 AND day <= ?2",
            params![from, to],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let streak_days = streak_days_for(c, today_idx)?;

    Ok(ReadingStats {
        range_seconds,
        by_day,
        pages_turned,
        books_touched,
        streak_days,
    })
}

/// Per-book totals (§4.8 get_book_stats).
///
/// `first_opened_at` = start of the earliest session day (unix ms); `last_opened_at` =
/// `books.last_opened_at` when known (set by B3 on open), else the latest session day.
pub fn get_book_stats(c: &Connection, uid: &str) -> anyhow::Result<BookStats> {
    let (total_seconds, pages_turned, first_day, last_day): (
        i64,
        i64,
        Option<String>,
        Option<String>,
    ) = c.query_row(
        "SELECT COALESCE(SUM(seconds), 0), COALESCE(SUM(pages_turned), 0), MIN(day), MAX(day) \
             FROM sessions WHERE book_uid = ?1",
        params![uid],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;

    // books row (B3 owns the table): last_opened_at + progress.
    let book: Option<(Option<i64>, f64)> = c
        .query_row(
            "SELECT last_opened_at, progress FROM books WHERE uid = ?1",
            params![uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (book_last_opened, progress) = book.unwrap_or((None, 0.0));

    let first_opened_at = first_day.as_deref().and_then(day_start_ms);
    let last_opened_at = book_last_opened.or_else(|| last_day.as_deref().and_then(day_start_ms));

    Ok(BookStats {
        total_seconds,
        pages_turned,
        first_opened_at,
        last_opened_at,
        progress,
    })
}

/// Consecutive *reading* days (≥ [`READING_DAY_SECONDS`] s, any book) ending today — or
/// ending yesterday when today has no reading yet, so the streak does not reset at 00:05.
fn streak_days_for(c: &Connection, today_idx: i64) -> anyhow::Result<i64> {
    let mut reading_days: HashSet<i64> = HashSet::new();
    {
        let mut stmt =
            c.prepare("SELECT day, SUM(seconds) AS s FROM sessions GROUP BY day HAVING s >= ?1")?;
        let rows = stmt.query_map(params![READING_DAY_SECONDS], |r| r.get::<_, String>(0))?;
        for row in rows {
            if let Some(idx) = parse_day(&row?) {
                reading_days.insert(idx);
            }
        }
    }

    // Anchor: today if it qualifies, else yesterday, else no streak.
    let start = if reading_days.contains(&today_idx) {
        today_idx
    } else if reading_days.contains(&(today_idx - 1)) {
        today_idx - 1
    } else {
        return Ok(0);
    };

    let mut streak = 0i64;
    let mut day = start;
    loop {
        streak += 1;
        day -= 1;
        if !reading_days.contains(&day) {
            break;
        }
    }
    Ok(streak)
}

/// Today's day index, from `db::today_str()` (falls back to the UTC day if unparseable).
pub(crate) fn today_day_index() -> i64 {
    parse_day(&today_str()).unwrap_or_else(|| crate::db::now_ms().div_euclid(86_400_000))
}

/// Day index of a past date relative to today, e.g. `day_index_back(1)` = yesterday.
/// Test/seed helper — keeps callers off hand-rolled date strings.
pub fn day_index_back(days_ago: i64) -> String {
    day_string(today_day_index() - days_ago)
}

/// `yyyy-mm-dd` → days since 1970-01-01, or `None` when the string is not a valid ISO day.
fn parse_day(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// Day index → `yyyy-mm-dd`.
fn day_string(idx: i64) -> String {
    let (y, m, d) = civil_from_days(idx);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Unix ms at local midnight of the given `yyyy-mm-dd` day, or `None` when the string is
/// not a valid ISO day.
///
/// `sessions.day` is a **local** date (`db::today_str` shifts by the cached UTC offset), so
/// the matching instant is `idx * 86_400_000 - offset_ms`. Using the same offset the writer
/// used keeps `BookStats.first_opened_at` / `last_opened_at` on the user's day boundaries
/// rather than UTC ones.
pub fn day_start_ms(day: &str) -> Option<i64> {
    let idx = parse_day(day)?;
    let offset_ms = i64::from(crate::db::local_offset_minutes()) * 60_000;
    Some(idx * 86_400_000 - offset_ms)
}

/// Howard Hinnant's public-domain `days_from_civil` (chrono-compatible calendar).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9) % 12; // Mar = 0
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant's public-domain `civil_from_days` (mirror of `db/mod.rs`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], Mar=0
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

// ---------------------------------------------------------------------------
// Tests (§8 B4): tick aggregation across days, stats math (streak!), ranges.
// Test-local §4.4 DDL via `db::annotations::testutil` — no dependency on `db::migrate`
// (B3, in flight).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::annotations::testutil::{conn, seed_book};

    /// Insert a session row for a specific day (bypasses `record_tick`'s "today").
    fn seed_session(c: &Connection, uid: &str, days_ago: i64, seconds: i64, pages: i64) {
        c.execute(
            "INSERT INTO sessions(book_uid, day, seconds, pages_turned) VALUES(?1, ?2, ?3, ?4)",
            params![uid, day_index_back(days_ago), seconds, pages],
        )
        .expect("seed session");
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // -- calendar helpers --------------------------------------------------

    #[test]
    fn b4_civil_calendar_roundtrip() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(day_string(days_from_civil(2024, 2, 29)), "2024-02-29");
        assert_eq!(day_string(days_from_civil(2024, 3, 1)), "2024-03-01");
        // round-trip a wide span, including leap years and month ends
        for idx in (-20_000..20_000).step_by(97) {
            let (y, m, d) = civil_from_days(idx);
            assert_eq!(days_from_civil(y, m as i64, d as i64), idx, "{y}-{m}-{d}");
        }
        assert_eq!(parse_day("2026-09-21"), Some(days_from_civil(2026, 9, 21)));
        assert_eq!(parse_day("junk"), None);
        assert_eq!(parse_day("2026-9-1"), None);
        assert_eq!(parse_day("2026-13-01"), None);
    }

    #[test]
    fn b4_day_index_back_walks_backwards() {
        let today = today_day_index();
        assert_eq!(day_index_back(0), day_string(today));
        assert_eq!(day_index_back(1), day_string(today - 1));
        assert_eq!(day_index_back(400), day_string(today - 400));
        assert_eq!(day_index_back(0), today_str());
    }

    #[test]
    fn b4_range_parsing() {
        assert_eq!(Range::parse("day"), Range::Day);
        assert_eq!(Range::parse("WEEK"), Range::Week);
        assert_eq!(Range::parse(" month "), Range::Month);
        assert_eq!(Range::parse("all"), Range::All);
        assert_eq!(Range::parse("nonsense"), Range::All, "unknown → all");
        assert_eq!(Range::Day.days(), Some(1));
        assert_eq!(Range::Week.days(), Some(7));
        assert_eq!(Range::Month.days(), Some(30));
        assert_eq!(Range::All.days(), None);
    }

    // -- record_tick -------------------------------------------------------

    #[test]
    fn b4_record_tick_merges_same_day() {
        let c = conn();
        record_tick(&c, A, 30, 2).unwrap();
        record_tick(&c, A, 30, 3).unwrap();
        record_tick(&c, A, 45, 0).unwrap();

        let today = today_str();
        let (rows, seconds, pages): (i64, i64, i64) = c
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(seconds),0), COALESCE(SUM(pages_turned),0) \
                 FROM sessions WHERE book_uid = ?1 AND day = ?2",
                params![A, today],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(rows, 1, "3 ticks on one day collapse into one row");
        assert_eq!(seconds, 105);
        assert_eq!(pages, 5);
    }

    #[test]
    fn b4_record_tick_separate_rows_across_days_and_books() {
        let c = conn();
        record_tick(&c, A, 30, 1).unwrap();
        record_tick(&c, B, 30, 1).unwrap();
        seed_session(&c, A, 1, 60, 4);
        seed_session(&c, A, 2, 90, 5);

        let rows: i64 = c
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 4, "one row per (book, day)");
        let a_rows: i64 = c
            .query_row(
                "SELECT COUNT(DISTINCT day) FROM sessions WHERE book_uid = ?1",
                params![A],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(a_rows, 3, "today + 2 back days");
    }

    // -- get_stats: windows ------------------------------------------------

    #[test]
    fn b4_stats_day_range_is_single_row() {
        let c = conn();
        seed_session(&c, A, 0, 120, 7);
        seed_session(&c, A, 1, 600, 40); // yesterday: outside `day`

        let s = get_stats(&c, "day").unwrap();
        assert_eq!(s.by_day.len(), 1);
        assert_eq!(s.by_day[0].date, today_str());
        assert_eq!(s.by_day[0].seconds, 120);
        assert_eq!(s.range_seconds, 120);
        assert_eq!(s.pages_turned, 7);
        assert_eq!(s.books_touched, 1);
    }

    #[test]
    fn b4_stats_week_fills_seven_rows_with_zeros() {
        let c = conn();
        seed_session(&c, A, 0, 100, 5);
        seed_session(&c, A, 6, 200, 9);

        let s = get_stats(&c, "week").unwrap();
        assert_eq!(s.by_day.len(), 7, "always 7 rows");
        // oldest first, ending today
        assert_eq!(s.by_day[6].date, today_str());
        assert_eq!(s.by_day[6].seconds, 100);
        assert_eq!(s.by_day[0].date, day_index_back(6));
        assert_eq!(s.by_day[0].seconds, 200);
        for d in &s.by_day[1..6] {
            assert_eq!(d.seconds, 0, "missing day zero-filled");
        }
        assert_eq!(s.range_seconds, 300);
        assert_eq!(s.pages_turned, 14);
    }

    #[test]
    fn b4_stats_week_excludes_day_eight() {
        let c = conn();
        seed_session(&c, A, 7, 999, 99); // just outside the 7-day window
        seed_session(&c, A, 0, 10, 1);

        let s = get_stats(&c, "week").unwrap();
        assert_eq!(s.range_seconds, 10);
        assert_eq!(s.pages_turned, 1);
        assert!(s.by_day.iter().all(|d| d.seconds < 999));
    }

    #[test]
    fn b4_stats_month_fills_thirty_rows() {
        let c = conn();
        seed_session(&c, A, 0, 60, 3);
        seed_session(&c, A, 29, 61, 4);
        seed_session(&c, A, 30, 5000, 500); // outside month

        let s = get_stats(&c, "month").unwrap();
        assert_eq!(s.by_day.len(), 30);
        assert_eq!(s.by_day[0].date, day_index_back(29));
        assert_eq!(s.by_day[0].seconds, 61);
        assert_eq!(s.by_day[29].date, today_str());
        assert_eq!(s.by_day[29].seconds, 60);
        assert_eq!(s.range_seconds, 121);
        assert_eq!(s.pages_turned, 7);
    }

    #[test]
    fn b4_stats_all_lists_only_days_with_data_oldest_first() {
        let c = conn();
        seed_session(&c, A, 0, 10, 1);
        seed_session(&c, A, 3, 20, 2);
        seed_session(&c, B, 100, 30, 3);

        let s = get_stats(&c, "all").unwrap();
        assert_eq!(s.by_day.len(), 3, "no zero-filling for `all`");
        assert_eq!(s.by_day[0].date, day_index_back(100));
        assert_eq!(s.by_day[1].date, day_index_back(3));
        assert_eq!(s.by_day[2].date, day_index_back(0));
        assert_eq!(s.range_seconds, 60);
        assert_eq!(s.pages_turned, 6);
        assert_eq!(s.books_touched, 2);
    }

    #[test]
    fn b4_stats_all_caps_at_365_days() {
        let c = conn();
        seed_session(&c, A, 364, 10, 1); // inside the cap
        seed_session(&c, A, 365, 20, 2); // exactly outside
        seed_session(&c, A, 900, 40, 4); // far outside

        let s = get_stats(&c, "all").unwrap();
        assert_eq!(s.by_day.len(), 1);
        assert_eq!(s.by_day[0].date, day_index_back(364));
        assert_eq!(s.range_seconds, 10);
        assert_eq!(s.pages_turned, 1);
    }

    #[test]
    fn b4_stats_sums_across_books_per_day() {
        let c = conn();
        seed_session(&c, A, 0, 100, 5);
        seed_session(&c, B, 0, 25, 2);

        let s = get_stats(&c, "week").unwrap();
        assert_eq!(s.by_day[6].seconds, 125, "both books on one day");
        assert_eq!(s.books_touched, 2);
        assert_eq!(s.pages_turned, 7);
    }

    #[test]
    fn b4_stats_books_touched_requires_seconds() {
        let c = conn();
        seed_session(&c, A, 0, 0, 12); // pages only, no seconds
        seed_session(&c, B, 0, 61, 0);

        let s = get_stats(&c, "week").unwrap();
        assert_eq!(s.books_touched, 1, "seconds > 0 only");
        assert_eq!(s.pages_turned, 12, "pages still counted");
    }

    #[test]
    fn b4_stats_empty_db_is_all_zeros() {
        let c = conn();
        for r in ["day", "week", "month", "all"] {
            let s = get_stats(&c, r).unwrap();
            assert_eq!(s.range_seconds, 0, "{r}");
            assert_eq!(s.pages_turned, 0, "{r}");
            assert_eq!(s.books_touched, 0, "{r}");
            assert_eq!(s.streak_days, 0, "{r}");
            let expected_rows = match Range::parse(r) {
                Range::Day => 1,
                Range::Week => 7,
                Range::Month => 30,
                Range::All => 0,
            };
            assert_eq!(s.by_day.len(), expected_rows, "{r}");
            assert!(s.by_day.iter().all(|d| d.seconds == 0), "{r}");
        }
    }

    // -- get_stats: streak math -------------------------------------------

    #[test]
    fn b4_streak_five_consecutive_days_then_gap() {
        let c = conn();
        // 5 reading days ending today, then a gap, then older noise
        for ago in 0..5 {
            seed_session(&c, A, ago, 120, 3);
        }
        seed_session(&c, A, 5, 0, 0); // gap: day with no reading
        seed_session(&c, A, 6, 900, 50);
        seed_session(&c, A, 7, 900, 50);

        assert_eq!(get_stats(&c, "week").unwrap().streak_days, 5);
        assert_eq!(get_stats(&c, "day").unwrap().streak_days, 5, "not windowed");
    }

    #[test]
    fn b4_streak_counts_from_yesterday_when_today_empty() {
        let c = conn();
        for ago in 1..=4 {
            seed_session(&c, A, ago, 300, 10);
        }
        // today: a row exists but with 0 seconds → not a reading day
        seed_session(&c, A, 0, 0, 3);

        assert_eq!(get_stats(&c, "week").unwrap().streak_days, 4);
    }

    #[test]
    fn b4_streak_zero_when_no_recent_reading() {
        let c = conn();
        seed_session(&c, A, 2, 300, 10);
        seed_session(&c, A, 3, 300, 10);
        // nothing today or yesterday → streak resets
        assert_eq!(get_stats(&c, "week").unwrap().streak_days, 0);
    }

    #[test]
    fn b4_streak_broken_by_short_day() {
        let c = conn();
        seed_session(&c, A, 0, 120, 3); // today ok
        seed_session(&c, A, 1, 120, 3); // yesterday ok
        seed_session(&c, A, 2, 59, 3); // 59 s < 60 → breaks
        seed_session(&c, A, 3, 120, 3);

        assert_eq!(get_stats(&c, "week").unwrap().streak_days, 2);
    }

    #[test]
    fn b4_streak_threshold_is_exactly_sixty() {
        let c = conn();
        seed_session(&c, A, 0, 60, 0);
        assert_eq!(get_stats(&c, "day").unwrap().streak_days, 1, ">= 60 counts");

        let c2 = conn();
        seed_session(&c2, A, 0, 59, 0);
        assert_eq!(get_stats(&c2, "day").unwrap().streak_days, 0, "59 does not");
    }

    #[test]
    fn b4_streak_sums_across_books_per_day() {
        let c = conn();
        seed_session(&c, A, 0, 40, 1);
        seed_session(&c, B, 0, 40, 1); // 40 + 40 = 80 ≥ 60 → reading day
        seed_session(&c, A, 1, 61, 1);

        assert_eq!(get_stats(&c, "week").unwrap().streak_days, 2);
    }

    // -- get_book_stats ----------------------------------------------------

    #[test]
    fn b4_book_stats_totals_and_timestamps() {
        let c = conn();
        seed_book(&c, A, Some(1_789_900_000_000), 0.42);
        seed_session(&c, A, 10, 100, 6);
        seed_session(&c, A, 2, 200, 9);
        seed_session(&c, B, 1, 5000, 500); // other book must not leak in

        let s = get_book_stats(&c, A).unwrap();
        assert_eq!(s.total_seconds, 300);
        assert_eq!(s.pages_turned, 15);
        assert_eq!(s.first_opened_at, day_start_ms(&day_index_back(10)));
        assert_eq!(s.last_opened_at, Some(1_789_900_000_000), "from books row");
        assert!((s.progress - 0.42).abs() < f64::EPSILON);
        assert!(s.first_opened_at.unwrap() < s.last_opened_at.unwrap());
    }

    #[test]
    fn b4_book_stats_without_books_row_falls_back_to_sessions() {
        let c = conn();
        seed_session(&c, A, 5, 61, 3);
        seed_session(&c, A, 1, 61, 3);

        let s = get_book_stats(&c, A).unwrap();
        assert_eq!(s.total_seconds, 122);
        assert_eq!(s.pages_turned, 6);
        assert_eq!(s.first_opened_at, day_start_ms(&day_index_back(5)));
        assert_eq!(s.last_opened_at, day_start_ms(&day_index_back(1)));
        assert_eq!(s.progress, 0.0);
    }

    #[test]
    fn b4_book_stats_unknown_book_is_empty_not_error() {
        let c = conn();
        seed_book(&c, A, None, 0.0);
        let s = get_book_stats(&c, "no-such-uid").unwrap();
        assert_eq!(s.total_seconds, 0);
        assert_eq!(s.pages_turned, 0);
        assert_eq!(s.first_opened_at, None);
        assert_eq!(s.last_opened_at, None);
        assert_eq!(s.progress, 0.0);
    }

    #[test]
    fn b4_stats_dtos_serialize_camel_case() {
        let c = conn();
        seed_session(&c, A, 0, 70, 2);
        let s = get_stats(&c, "week").unwrap();
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["rangeSeconds"], 70);
        assert_eq!(json["pagesTurned"], 2);
        assert_eq!(json["booksTouched"], 1);
        assert_eq!(json["streakDays"], 1);
        assert_eq!(json["byDay"].as_array().unwrap().len(), 7);
        assert_eq!(json["byDay"][6]["date"], today_str());
        assert!(json.get("range_seconds").is_none(), "must be camelCase");

        let b = serde_json::to_value(get_book_stats(&c, A).unwrap()).unwrap();
        assert_eq!(b["totalSeconds"], 70);
        assert!(b.get("firstOpenedAt").is_some());
        assert!(b.get("lastOpenedAt").is_some());
    }
}
