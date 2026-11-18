//! Secret storage for the Groq API key: the OS credential store (macOS Keychain, Windows Credential Manager).
//! Other platforms report "unavailable", and the caller falls back to the app data file with a visible warning.

pub trait SecretStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, value: &str) -> Result<(), String>;
    /// Removing a secret that does not exist is not an error.
    fn delete(&self) -> Result<(), String>;
}

const SERVICE: &str = "com.markdowncompanion.app";
const ACCOUNT: &str = "groq-api-key";

/// The operating system's credential store.
pub struct Keychain {
    service: String,
}

impl Keychain {
    /// Unused in test builds, which use `MemorySecrets` so tests never touch the real credential store.
    #[cfg_attr(test, allow(dead_code))]
    pub fn new() -> Self {
        Keychain { service: SERVICE.to_string() }
    }

    #[cfg(test)]
    fn with_service(service: &str) -> Self {
        Keychain { service: service.to_string() }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        match keyring::Entry::new(&self.service, ACCOUNT).map_err(|e| e.to_string())?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, value: &str) -> Result<(), String> {
        keyring::Entry::new(&self.service, ACCOUNT).map_err(|e| e.to_string())?.set_password(value).map_err(|e| e.to_string())
    }

    fn delete(&self) -> Result<(), String> {
        match keyring::Entry::new(&self.service, ACCOUNT).map_err(|e| e.to_string())?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl SecretStore for Keychain {
    fn get(&self) -> Result<Option<String>, String> {
        let _ = (&self.service, ACCOUNT);
        Err("No secure credential store is available on this platform".into())
    }
    fn set(&self, _: &str) -> Result<(), String> {
        Err("No secure credential store is available on this platform".into())
    }
    fn delete(&self) -> Result<(), String> {
        Err("No secure credential store is available on this platform".into())
    }
}

/// In-memory store for tests; can be told to fail to exercise the fallback path.
#[cfg(test)]
#[derive(Default)]
pub struct MemorySecrets {
    value: std::sync::Mutex<Option<String>>,
    pub fail: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl MemorySecrets {
    fn check(&self) -> Result<(), String> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) { Err("keychain locked".into()) } else { Ok(()) }
    }
}

#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self) -> Result<Option<String>, String> {
        self.check()?;
        Ok(self.value.lock().unwrap().clone())
    }
    fn set(&self, value: &str) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap() = Some(value.to_string());
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        self.check()?;
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Touches the real OS credential store with a throwaway service name. Run manually:
    /// `cargo test --lib keychain_round_trip -- --ignored` (macOS may ask for permission).
    #[test]
    #[ignore]
    fn keychain_round_trip() {
        let k = Keychain::with_service(&format!("com.markdowncompanion.test.{}", std::process::id()));
        k.delete().unwrap();
        assert_eq!(k.get().unwrap(), None);
        k.set("gsk_test_value").unwrap();
        assert_eq!(k.get().unwrap().as_deref(), Some("gsk_test_value"));
        k.delete().unwrap();
        assert_eq!(k.get().unwrap(), None);
    }
}
