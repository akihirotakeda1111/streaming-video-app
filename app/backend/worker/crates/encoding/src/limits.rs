//! Explicit per-job resource limits and conservative shared disk admission.
use crate::{Command, Execute, Output, ProcessError};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub source_bytes: u64,
    pub temporary_bytes: u64,
    pub disk_reserve_bytes: u64,
    pub threads: u32,
    pub duration_seconds: u64,
    pub wall_seconds: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            source_bytes: 64 * 1024 * 1024,
            temporary_bytes: 512 * 1024 * 1024,
            disk_reserve_bytes: 256 * 1024 * 1024,
            threads: 1,
            duration_seconds: 3600,
            wall_seconds: 7200,
        }
    }
}
impl Limits {
    pub fn from_lookup(lookup: &impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        fn number(
            lookup: &impl Fn(&str) -> Option<String>,
            key: &str,
            default: u64,
            max: u64,
        ) -> Result<u64, &'static str> {
            let value = match lookup(key) {
                None => default,
                Some(s) => s.trim().parse().map_err(|_| "invalid limit")?,
            };
            if value == 0 || value > max {
                return Err("invalid limit");
            }
            Ok(value)
        }
        let d = Self::default();
        let result = Self {
            source_bytes: number(
                lookup,
                "WORKER_MAX_SOURCE_BYTES",
                d.source_bytes,
                1024 * 1024 * 1024,
            )?,
            temporary_bytes: number(
                lookup,
                "WORKER_MAX_TEMP_BYTES",
                d.temporary_bytes,
                16 * 1024 * 1024 * 1024,
            )?,
            disk_reserve_bytes: number(
                lookup,
                "WORKER_DISK_RESERVE_BYTES",
                d.disk_reserve_bytes,
                16 * 1024 * 1024 * 1024,
            )?,
            threads: number(lookup, "WORKER_FFMPEG_THREADS", d.threads.into(), 16)? as u32,
            duration_seconds: number(
                lookup,
                "WORKER_MAX_DURATION_SECONDS",
                d.duration_seconds,
                14400,
            )?,
            wall_seconds: number(lookup, "WORKER_MAX_WALL_SECONDS", d.wall_seconds, 43200)?,
        };
        if result.temporary_bytes <= result.source_bytes {
            return Err("temporary limit must exceed source limit");
        }
        Ok(result)
    }
}

#[derive(Clone, Default)]
pub struct DiskBudget(Arc<Mutex<u64>>);
pub struct Reservation {
    budget: DiskBudget,
    bytes: u64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        *self.budget.0.lock().unwrap() -= self.bytes;
    }
}
impl DiskBudget {
    pub fn reserve(&self, root: &Path, limits: &Limits) -> Result<Reservation, String> {
        let available =
            fs2::available_space(root).map_err(|_| "cannot determine available disk space")?;
        self.reserve_available(available, limits)
    }
    fn reserve_available(&self, available: u64, limits: &Limits) -> Result<Reservation, String> {
        let mut reserved = self.0.lock().unwrap();
        if available
            < reserved
                .saturating_add(limits.temporary_bytes)
                .saturating_add(limits.disk_reserve_bytes)
        {
            return Err("insufficient temporary disk space".into());
        }
        *reserved += limits.temporary_bytes;
        Ok(Reservation {
            budget: self.clone(),
            bytes: limits.temporary_bytes,
        })
    }
}

pub fn directory_bytes(root: &Path) -> Result<u64, ProcessError> {
    let mut total = 0u64;
    for entry in std::fs::read_dir(root)
        .map_err(|_| ProcessError("cannot inspect temporary files".into()))?
    {
        let entry = entry.map_err(|_| ProcessError("cannot inspect temporary file".into()))?;
        let metadata = entry
            .metadata()
            .map_err(|_| ProcessError("cannot inspect temporary file".into()))?;
        if !metadata.is_file() {
            return Err(ProcessError("unexpected temporary entry".into()));
        }
        total = total
            .checked_add(metadata.len())
            .ok_or_else(|| ProcessError("temporary size overflow".into()))?;
    }
    Ok(total)
}

pub struct BoundedExecutor {
    pub limits: Limits,
}
impl Execute for BoundedExecutor {
    async fn execute(&mut self, mut command: Command) -> Result<Output, ProcessError> {
        let playlist = PathBuf::from(
            command
                .argv
                .last()
                .ok_or_else(|| ProcessError("missing HLS output".into()))?,
        );
        let root = playlist
            .parent()
            .ok_or_else(|| ProcessError("missing work directory".into()))?
            .to_owned();
        let mut probe_path = command.executable.clone();
        probe_path.set_file_name(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        let probe = Command::new(
            probe_path,
            vec![
                "-v".into(),
                "error".into(),
                "-show_entries".into(),
                "format=duration".into(),
                "-of".into(),
                "default=noprint_wrappers=1:nokey=1".into(),
                root.join("source.mp4").to_string_lossy().into_owned(),
            ],
        );
        let mut executor = crate::runtime::ProcessExecutor;
        let output = tokio::time::timeout(Duration::from_secs(10), executor.execute(probe))
            .await
            .map_err(|_| ProcessError("source probe timed out".into()))??;
        let duration: f64 = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .map_err(|_| ProcessError("invalid source duration".into()))?;
        if output.status != 0
            || !duration.is_finite()
            || duration <= 0.0
            || duration > self.limits.duration_seconds as f64
        {
            return Err(ProcessError(
                "source duration exceeds limit or is invalid".into(),
            ));
        }
        // Set decoder and encoder limits separately, as FFmpeg options are positional.
        let input = command
            .argv
            .iter()
            .position(|s| s == "-i")
            .ok_or_else(|| ProcessError("missing input".into()))?;
        command.argv.splice(
            input..input,
            ["-threads".into(), self.limits.threads.to_string()],
        );
        let output_index = command.argv.len() - 1;
        command.argv.splice(
            output_index..output_index,
            [
                "-threads".into(),
                self.limits.threads.to_string(),
                "-filter_threads".into(),
                self.limits.threads.to_string(),
                "-filter_complex_threads".into(),
                self.limits.threads.to_string(),
                "-t".into(),
                self.limits.duration_seconds.to_string(),
            ],
        );
        command.maximum_file_bytes = Some(self.limits.temporary_bytes - self.limits.source_bytes);
        let execute = executor.execute(command);
        tokio::pin!(execute);
        let deadline = tokio::time::sleep(Duration::from_secs(self.limits.wall_seconds));
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                biased;
                _ = &mut deadline => return Err(ProcessError("encode wall time exceeded".into())),
                _ = tick.tick() => {
                    if directory_bytes(&root)? >= self.limits.temporary_bytes
                        || fs2::available_space(&root).map_err(|_| ProcessError("cannot inspect disk space".into()))? < self.limits.disk_reserve_bytes {
                        return Err(ProcessError("temporary disk limit exceeded".into()));
                    }
                }
                output = &mut execute => {
                    if directory_bytes(&root)? > self.limits.temporary_bytes { return Err(ProcessError("temporary disk limit exceeded".into())); }
                    return output;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reservations_account_for_other_jobs_and_release_on_drop() {
        let budget = DiskBudget::default();
        let limits = Limits {
            temporary_bytes: 100,
            disk_reserve_bytes: 20,
            ..Limits::default()
        };
        let first = budget.reserve_available(150, &limits).unwrap();
        assert!(budget.reserve_available(150, &limits).is_err());
        drop(first);
        assert!(budget.reserve_available(150, &limits).is_ok());
        assert!(budget.reserve_available(119, &limits).is_err());
    }
    #[test]
    fn rejects_invalid_and_inconsistent_limits() {
        for key in [
            "WORKER_MAX_SOURCE_BYTES",
            "WORKER_MAX_TEMP_BYTES",
            "WORKER_DISK_RESERVE_BYTES",
            "WORKER_FFMPEG_THREADS",
            "WORKER_MAX_DURATION_SECONDS",
            "WORKER_MAX_WALL_SECONDS",
        ] {
            for value in ["0", "-1", "", "18446744073709551615"] {
                assert!(Limits::from_lookup(&|k| (k == key).then(|| value.into())).is_err());
            }
        }
        assert!(
            Limits::from_lookup(&|k| (k == "WORKER_MAX_TEMP_BYTES").then(|| "1".into())).is_err()
        );
    }
}
