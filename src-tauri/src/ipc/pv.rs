//! 文字 PV 的**分块落盘**。JIZURA 导出 MP4 走浏览器下载（blob + `<a download>`），在
//! WebView2 里只能落到系统下载目录、用户没得选；我们把那次保存拦下来、让用户选目录，
//! 再把字节分块交给后端 —— 所以需要一条「写任意二进制」的命令。
//!
//! **为什么是分块**：4K 的 MP4 有几百 MB，分块之后峰值内存只有一块的大小（与成片大小
//! 无关），中途可以取消、可以报进度。**别为了"IPC 方便"改成一次传完** —— 那等于把几百
//! MB 同时按在 WebView 和 Rust 两边的内存里。
//! 路径安全（三条，缺一不可）：`dir` 必须**已存在且是目录**（不自动创建）；`name` 只取
//! 最后一段并过滤非法字符，否则 `name=..\..\Windows\System32\x.dll` 能写到任意位置；
//! 同名文件**不覆盖**，0 号块落盘时自动加 `(1)(2)…`，之后的块沿用那个名字。

use std::path::{Path, PathBuf};

use serde_json::json;

use super::Cmd;

/// 单块上限 16MB；前端按 8MB 切，留一倍余量。
///
/// ⚠️ **IPC 没有 body limit 这个概念**（框架不会替我们拦），
/// 所以这个上限是**自己守的**：超了就直接报错。
pub const PV_CHUNK_LIMIT: usize = 16 * 1024 * 1024;

/// 写一块二进制到 `<dir>/<name>`。
///
/// `part`：第几块（从 0 开始）。**0 是新建**（同名自动改名），之后是追加。
/// `total`：一共几块。用来算 `done` —— 只靠 `part` 自己判断不出「这是不是最后一块」。
/// 调用方必须按顺序传，中途失败直接重来（不做断点续传 —— 这是导出，不是下载）。
#[tauri::command]
pub async fn pv_save_chunk(
    dir: String,
    name: String,
    part: u32,
    total: u32,
    bytes: Vec<u8>,
) -> Cmd {
    if bytes.len() > PV_CHUNK_LIMIT {
        return Err(format!(
            "单块不能超过 {} MiB",
            PV_CHUNK_LIMIT / (1024 * 1024)
        ));
    }
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("缺少保存目录".into());
    }
    let dir_path = PathBuf::from(dir);
    if !dir_path.is_dir() {
        return Err(format!("目录不存在：{}", dir_path.display()));
    }

    let name = safe_file_name(&name);
    let path = target_file(&dir_path, &name, part);

    // 0 号块新建（同名已经改成不重名的那个），之后的块追加。
    // 异步写：保存目录是用户随便选的，慢盘上一个 16MB 块能同步写掉几秒，
    // 那期间 Tokio 上所有 IPC 命令一起停住
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(part > 0)
            .write(true)
            .truncate(part == 0)
            .open(&path)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
    }

    let size = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "path": crate::platform::clean_path(&path),
        "name": path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or(name),
        "size": size,
        "part": part,
        // 最后一块写完就没用了：告诉前端一声，它好去播放/定位
        "done": part + 1 >= total.max(1),
    }))
}

/// 文件名只保留最后一段，并清掉 Windows 不允许、或者能改变路径含义的字符。
fn safe_file_name(raw: &str) -> String {
    let last = raw
        .rsplit(['\\', '/'])
        .find(|s| !s.trim().is_empty())
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 目标文件。`part > 0` 按**调用方传来的名字**去追加，而那个名字必须是 0 号块回给它的
/// `name`（同名时 0 号块会把它改成 `xxx (1).mp4`）—— 传原名会把后面的块追加进用户早就
/// 存在的同名文件，新导出的那份只剩 0 号块。`part == 0` 挑一个不重名的。
fn target_file(dir: &Path, name: &str, part: u32) -> PathBuf {
    let first = dir.join(name);
    if part > 0 {
        if first.exists() {
            return first;
        }
        // 0 号块已把名字改成不重名的那个（`xxx (1).mp4`）—— 按同样的规则倒着找回去
        let stem = first
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = first.extension().map(|s| s.to_string_lossy().to_string());
        for n in 1..100 {
            let cand = match &ext {
                Some(e) => dir.join(format!("{stem} ({n}).{e}")),
                None => dir.join(format!("{stem} ({n})")),
            };
            if cand.exists() {
                return cand;
            }
        }
        return first;
    }

    if !first.exists() {
        return first;
    }
    let stem = first
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = first.extension().map(|s| s.to_string_lossy().to_string());
    for n in 1..1000 {
        let cand = match &ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    first
}
