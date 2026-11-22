//! Opt-in phase totals. Extraction workers measure their own elapsed time.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Totals(BTreeMap<&'static str, Duration>);

thread_local! {
    static TOTALS: RefCell<Option<Totals>> = const { RefCell::new(None) };
}

pub fn enable() {
    TOTALS.with_borrow_mut(|totals| *totals = Some(Totals::default()));
}

pub fn enabled() -> bool {
    TOTALS.with_borrow(Option::is_some)
}

pub fn take() -> Option<Totals> {
    TOTALS.take()
}

pub fn merge(other: Totals) {
    for (phase, elapsed) in other.0 {
        record(phase, elapsed);
    }
}

impl Totals {
    pub fn milliseconds(self) -> BTreeMap<&'static str, f64> {
        self.0
            .into_iter()
            .map(|(phase, elapsed)| (phase, (elapsed.as_secs_f64() * 10_000.0).round() / 10.0))
            .collect()
    }
}

fn record(phase: &'static str, elapsed: Duration) {
    TOTALS.with_borrow_mut(|totals| {
        if let Some(totals) = totals {
            *totals.0.entry(phase).or_default() += elapsed;
        }
    });
}

pub struct Timer(Option<(&'static str, Instant)>);

impl Timer {
    pub fn start(phase: &'static str) -> Self {
        Self(enabled().then(|| (phase, Instant::now())))
    }
}

impl Drop for Timer {
    fn drop(&mut self) {
        if let Some((phase, start)) = self.0 {
            record(phase, start.elapsed());
        }
    }
}

pub fn measure<T>(phase: &'static str, run: impl FnOnce() -> T) -> T {
    let _timer = Timer::start(phase);
    run()
}
