use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct CredentialState {
    lock: Arc<Mutex<()>>,
}

fn validate_secret_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-' | b'.'))
    {
        return Err("The credential identifier is invalid".into());
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn vault_get(service: &str, id: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(service, id)
        .map_err(|_| "The operating system credential vault is unavailable")?;
    match entry.get_password() {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(_) => Err("The operating system credential vault is locked or unavailable".into()),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn vault_set(service: &str, id: &str, value: Option<&str>) -> Result<(), String> {
    let entry = keyring::Entry::new(service, id)
        .map_err(|_| "The operating system credential vault is unavailable")?;
    match value.filter(|value| !value.is_empty()) {
        Some(value) => entry
            .set_password(value)
            .map_err(|_| "Could not save the key in the operating system credential vault".into()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(
                "Could not remove the saved key from the operating system credential vault".into(),
            ),
        },
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn vault_get(_service: &str, _id: &str) -> Result<String, String> {
    Err("Credential storage is supported on Windows, macOS and Linux".into())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn vault_set(_service: &str, _id: &str, _value: Option<&str>) -> Result<(), String> {
    Err("Credential storage is supported on Windows, macOS and Linux".into())
}

#[tauri::command]
pub async fn get_secret(
    app: AppHandle,
    state: State<'_, CredentialState>,
    id: String,
) -> Result<String, String> {
    validate_secret_id(&id)?;
    let service = app.config().identifier.clone();
    let lock = state.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "The credential vault lock is unavailable")?;
        vault_get(&service, &id)
    })
    .await
    .map_err(|_| "Could not access the credential vault")?
}

#[tauri::command]
pub async fn set_secret(
    app: AppHandle,
    state: State<'_, CredentialState>,
    id: String,
    value: Option<String>,
) -> Result<(), String> {
    validate_secret_id(&id)?;
    let service = app.config().identifier.clone();
    if value
        .as_ref()
        .is_some_and(|value| value.len() > 4096 || value.contains('\0'))
    {
        return Err(
            "API keys must be no larger than 4096 bytes and contain no null characters".into(),
        );
    }
    let lock = state.lock.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "The credential vault lock is unavailable")?;
        vault_set(&service, &id, value.as_deref())
    })
    .await
    .map_err(|_| "Could not access the credential vault")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_ids_are_namespaced_without_paths_or_control_characters() {
        assert!(validate_secret_id("provider:openrouter").is_ok());
        assert!(validate_secret_id("firecrawl").is_ok());
        assert!(validate_secret_id("").is_err());
        assert!(validate_secret_id("../another-app").is_err());
        assert!(validate_secret_id("provider:\nopenai").is_err());
        assert!(validate_secret_id(&"a".repeat(129)).is_err());
    }
}
