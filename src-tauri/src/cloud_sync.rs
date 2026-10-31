use std::path::Path;

const MAX_PATHS: usize = 4096;
const MAX_PATH_BYTES: usize = 32_768;

/// Which of these absolute paths exist on this computer. Cloud sync uses it
/// to map files that another device linked to notes onto folders here. It
/// reads no file contents and follows no relative paths.
#[tauri::command]
pub async fn cloud_paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    if paths.len() > MAX_PATHS {
        return Err(format!("Check at most {MAX_PATHS} paths at once"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| {
                path.len() <= MAX_PATH_BYTES
                    && !path.contains('\0')
                    && Path::new(path).is_absolute()
                    && Path::new(path).is_file()
            })
            .collect()
    })
    .await
    .map_err(|error| format!("Could not check the files: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_existing_absolute_files_count() {
        let folder = std::env::temp_dir().join(format!("typenext-cloud-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("note.md");
        std::fs::write(&file, "hello").unwrap();
        let result = cloud_paths_exist(vec![
            file.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
            folder.join("missing.md").to_string_lossy().into_owned(),
            "relative/note.md".into(),
        ])
        .await
        .unwrap();
        assert_eq!(result, vec![true, false, false, false]);
        assert!(cloud_paths_exist(vec![String::new(); MAX_PATHS + 1]).await.is_err());
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
