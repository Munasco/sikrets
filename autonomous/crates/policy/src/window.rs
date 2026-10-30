//! Rolling sum over a time window in O(1) per update.
//!
//! The window is split into 64 buckets. Adding touches one bucket; advancing clears only the
//! buckets that fell out since the last call (at most 64, usually 0 or 1). The sum is kept
//! alongside, so a check is one add and one compare. Bucketing makes the window up to one bucket
//! longer than asked, which errs on the strict side.

use sikrets_core::Millis;

const BUCKETS: usize = 64;
const MASK: u64 = BUCKETS as u64 - 1;

#[derive(Debug, Clone)]
pub struct Window {
    bucket_ms: Millis,
    max: u64,
    /// Absolute index (time / bucket_ms) of the newest bucket.
    head: u64,
    sum: u64,
    buckets: [u64; BUCKETS],
}

impl Window {
    pub fn new(span_ms: Millis, max: u64) -> Self {
        Self { bucket_ms: span_ms.div_ceil(BUCKETS as u64).max(1), max, head: 0, sum: 0, buckets: [0; BUCKETS] }
    }

    #[inline(always)]
    pub fn advance(&mut self, now: Millis) {
        let at = now / self.bucket_ms;
        if at <= self.head {
            return;
        }
        let gone = (at - self.head).min(BUCKETS as u64);
        for i in 1..=gone {
            let b = &mut self.buckets[((self.head + i) & MASK) as usize];
            self.sum -= *b;
            *b = 0;
        }
        self.head = at;
    }

    #[inline(always)]
    pub fn would_exceed(&self, amount: u64) -> bool {
        self.sum.saturating_add(amount) > self.max
    }

    /// Adds `amount` at `now`. Call [`Window::advance`] first.
    #[inline(always)]
    pub fn add(&mut self, now: Millis, amount: u64) {
        // Late events (now older than head) land in the newest bucket: they still count.
        let at = (now / self.bucket_ms).max(self.head);
        self.buckets[(at & MASK) as usize] += amount;
        self.sum += amount;
    }

    pub fn sum(&self) -> u64 {
        self.sum
    }
    pub fn max(&self) -> u64 {
        self.max
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slides() {
        let mut w = Window::new(64_000, 100); // 1s buckets
        w.advance(0);
        w.add(0, 60);
        w.advance(30_000);
        assert!(w.would_exceed(41));
        assert!(!w.would_exceed(40));
        w.add(30_000, 40);
        w.advance(64_000); // first add has left the window
        assert_eq!(w.sum(), 40);
        w.advance(1_000_000); // everything has
        assert_eq!(w.sum(), 0);
    }

    #[test]
    fn matches_a_naive_window() {
        // Pseudo-random events checked against an O(n) reference with the same bucketing.
        let span = 10_000;
        let mut w = Window::new(span, u64::MAX);
        let bucket = span.div_ceil(64);
        let mut events: Vec<(u64, u64)> = Vec::new();
        let mut t = 0u64;
        let mut x = 0x9E3779B97F4A7C15u64;
        for _ in 0..5_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            t += x % 700;
            let amount = x % 1_000;
            w.advance(t);
            w.add(t, amount);
            events.push((t, amount));
            let head = t / bucket;
            let naive: u64 = events.iter().filter(|(at, _)| head - at / bucket < 64).map(|(_, a)| a).sum();
            assert_eq!(w.sum(), naive, "at {t}");
        }
    }
}
