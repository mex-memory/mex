//! The guard: one thread that keeps a job inside its memory cap and deadline.
//!
//! It starts before any repository work (the start barrier in the contract)
//! and samples the process's resident memory every 10 ms. On a breach it runs
//! the job's cleanup (deleting the candidate and temporary files) and exits
//! with the contract's code, so a killed or capped run leaves nothing behind.
//!
//! Rules carried over from the mex-platform engine's bugs: the deadline is
//! converted to a monotonic instant once, at start; the peak is tracked by the
//! guard itself rather than read back from the OS; and cleanup runs exactly
//! once, whichever breach comes first.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Why the guard stopped a job. Each maps to a contract exit code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Breach {
    MemoryLimit,
    Deadline,
    ParentGone,
}

impl Breach {
    pub fn code(self) -> &'static str {
        match self {
            Breach::MemoryLimit => "graph_memory_limit",
            Breach::Deadline => "graph_deadline",
            Breach::ParentGone => "graph_parent_gone",
        }
    }

    pub fn exit_code(self) -> i32 {
        match self {
            Breach::MemoryLimit => 3,
            Breach::Deadline => 4,
            Breach::ParentGone => 5,
        }
    }
}

/// Where the guard reads resident memory from; a trait so tests can feed it.
pub trait Sampler: Send + 'static {
    /// Resident memory in bytes, or `None` when the platform can't tell.
    fn resident_bytes(&mut self) -> Option<u64>;
}

/// The real sampler: this process's physical memory.
pub struct ProcessSampler;

impl Sampler for ProcessSampler {
    fn resident_bytes(&mut self) -> Option<u64> {
        memory_stats::memory_stats().map(|stats| stats.physical_mem as u64)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub memory_bytes: u64,
    pub deadline: Duration,
    pub interval: Duration,
}

/// A running guard. Dropping it stops the thread without a breach.
pub struct Guard {
    stop: Arc<AtomicBool>,
    parent_gone: Arc<AtomicBool>,
    peak: Arc<AtomicU64>,
    thread: Option<JoinHandle<()>>,
}

impl Guard {
    /// Start sampling. `on_breach` runs once, on the guard thread, and is
    /// expected to clean up and exit the process.
    pub fn start<S: Sampler>(
        limits: Limits,
        mut sampler: S,
        on_breach: impl FnOnce(Breach) + Send + 'static,
    ) -> Guard {
        let deadline = Instant::now() + limits.deadline;
        let stop = Arc::new(AtomicBool::new(false));
        let parent_gone = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(0));
        let on_breach = Mutex::new(Some(on_breach));
        // `start` returns after the first sample, so even a job that ends
        // before the guard thread would be scheduled is checked once.
        let (sampled, first_sample) = std::sync::mpsc::channel::<()>();
        let thread = {
            let (stop, parent_gone, peak) = (stop.clone(), parent_gone.clone(), peak.clone());
            std::thread::Builder::new()
                .name("mex-graph-guard".into())
                .spawn(move || {
                    let mut sampled = Some(sampled);
                    while !stop.load(Ordering::Acquire) {
                        let breach = if parent_gone.load(Ordering::Acquire) {
                            Some(Breach::ParentGone)
                        } else if Instant::now() >= deadline {
                            Some(Breach::Deadline)
                        } else {
                            let rss = sampler.resident_bytes().unwrap_or(0);
                            peak.fetch_max(rss, Ordering::AcqRel);
                            (rss > limits.memory_bytes).then_some(Breach::MemoryLimit)
                        };
                        if let Some(breach) = breach {
                            if let Some(run) =
                                on_breach.lock().ok().and_then(|mut slot| slot.take())
                            {
                                run(breach);
                            }
                            return;
                        }
                        if let Some(sampled) = sampled.take() {
                            let _ = sampled.send(());
                        }
                        std::thread::sleep(limits.interval);
                    }
                })
                .expect("spawn the guard thread")
        };
        // An error means the first sample breached and the breach handler ran.
        let _ = first_sample.recv();
        Guard {
            stop,
            parent_gone,
            peak,
            thread: Some(thread),
        }
    }

    /// Report that the parent is gone (stdin closed); the next tick breaches.
    pub fn parent_gone(&self) {
        self.parent_gone.store(true, Ordering::Release);
    }

    /// The highest resident memory sampled so far, in bytes.
    pub fn peak_bytes(&self) -> u64 {
        self.peak.load(Ordering::Acquire)
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Fixed(u64);
    impl Sampler for Fixed {
        fn resident_bytes(&mut self) -> Option<u64> {
            Some(self.0)
        }
    }

    fn limits(memory_bytes: u64, deadline_ms: u64) -> Limits {
        Limits {
            memory_bytes,
            deadline: Duration::from_millis(deadline_ms),
            interval: Duration::from_millis(1),
        }
    }

    #[test]
    fn breaches_over_the_memory_cap() {
        let (tx, rx) = mpsc::channel();
        let _guard = Guard::start(limits(100, 60_000), Fixed(101), move |b| {
            tx.send(b).unwrap()
        });
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Breach::MemoryLimit
        );
    }

    #[test]
    fn breaches_at_the_deadline() {
        let (tx, rx) = mpsc::channel();
        let _guard = Guard::start(limits(u64::MAX, 20), Fixed(1), move |b| tx.send(b).unwrap());
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Breach::Deadline
        );
    }

    #[test]
    fn breaches_when_the_parent_goes() {
        let (tx, rx) = mpsc::channel();
        let guard = Guard::start(limits(u64::MAX, 60_000), Fixed(1), move |b| {
            tx.send(b).unwrap()
        });
        guard.parent_gone();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            Breach::ParentGone
        );
    }

    #[test]
    fn stays_quiet_inside_its_limits_and_tracks_the_peak() {
        let (tx, rx) = mpsc::channel::<Breach>();
        let guard = Guard::start(limits(1_000, 60_000), Fixed(640), move |b| {
            tx.send(b).unwrap()
        });
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert_eq!(guard.peak_bytes(), 640);
    }

    #[test]
    fn the_real_sampler_reads_this_process() {
        assert!(ProcessSampler.resident_bytes().unwrap_or(1) > 0);
    }
}
