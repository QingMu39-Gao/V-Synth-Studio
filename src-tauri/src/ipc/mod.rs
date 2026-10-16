//! IPC 命令层 —— **前端唯一能碰到后端的入口**。命令只做搬运：解参数 → 调领域函数
//! （`libresvip.rs` / `lyrics.rs` / `bili.rs` / `ytdlp.rs` / `audio.rs` / `svsep.rs` /
//! `midi_transcribe.rs` / `platform.rs`）→ 回值。**业务逻辑不许写在这一层**，也
//! **别为了「顺手起个 HTTP 端点」把 `axum` 加回来**：前端加载的是 Tauri 资源协议。
//!
//! ⚠️ **命令名全局唯一**：`generate_handler!` 里的名字不按模块作用域，两个模块各有一个
//! `status` 就会撞名，所以带前缀（`svsep_*` / `midi_*` / `lyrics_*` / `video_*` /
//! `audio_*` / `bili_*` / `convert_*` / `pv_*`）。另一个后果：`#[tauri::command]` 会为
//! 命令名生成同名包装项，所以**别的模块别按那个名字去调同名逻辑函数** —— 会解析到宏
//! 生成的那个，报出「expected `State<Arc<AppState>>`, found `&Arc<AppState>`」。
//!
//! ⚠️ **注册点只有一个**：`lib.rs` 的 `generate_handler!`。加命令要
//! 两处一起改 —— 这里写函数、`lib.rs` 登记；漏登记的表现是「前端调用报 command not
//! found」，不报编译错。
//!
//! 出错回 `Err(String)`，前端 `invoke` 抛成 `Error`；成功回业务对象本身，**没有
//! `{ok:true}` 信封**。

pub mod bili;
pub mod config;
pub mod config_file;
pub mod convert;
pub mod fs;
pub mod jobs;
pub mod lyrics;
pub mod media;
pub mod midi;
pub mod pv;
pub mod state;
pub mod svsep;
pub mod tools;
pub mod update;
pub mod wallpaper;

use std::sync::Arc;

pub use crate::ipc::state::AppState;

/// IPC 命令的返回类型。
///
/// 成功给 `serde_json::Value`（Tauri 直接序列化给前端），失败给一句**给用户看的人话**。
/// 刻意不用 `ApiError` —— 那是 HTTP 层的类型，带着状态码，而 IPC 没有状态码这个概念。
pub type Cmd = Result<serde_json::Value, String>;

/// 命令体里常见的「拿状态」：`State<Arc<AppState>>`。
///
/// Tauri 的 `State<T>` 要求 `T: Send + Sync + 'static`，`Arc<AppState>` 满足；
/// 状态是在 `lib.rs` 的 setup 里 `app.manage()` 进来的。
pub type St<'a> = tauri::State<'a, Arc<AppState>>;
