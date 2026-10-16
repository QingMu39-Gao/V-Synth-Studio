//! 「检查更新」与「下载新版本」两条命令。
//!
//! ⚠️ 上游没发过 Release、GitHub 匿名调用超额都是 `ok: false` 的**成功回包**，
//! 只有真连不上才回 `Err` —— 两种在界面上都只是一句话，见 `crate::update`。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use super::Cmd;

/// 问一次最新发布（见 `crate::update`）。
#[tauri::command]
pub async fn update_check() -> Cmd {
    crate::update::check().await
}

/// 安装包落在哪个目录：`<可写目录>/updates/`。
///
/// 不用系统临时目录：那个随时会被清理，而用户可能「下载完先不装」；也不丢桌面
/// （污染用户桌面）。落在可写目录里，绿色版跟着程序走、安装版在 `%APPDATA%` 下，
/// 「关于」页里本来就写明了可写目录在哪。
fn updates_dir(st: &Arc<super::AppState>) -> PathBuf {
    st.writable.join("updates")
}

/// 一个候选地址能不能下。
///
/// 与 `update::allowed_base` 同一条规矩：只收 https，明文 http 只放行本机
/// （`127.0.0.1` / `localhost`）—— 下载链路是「新版本从哪来」的另一半，也不能交给中间人。
fn allowed_url(url: &str) -> bool {
    let u = url.trim();
    if u.starts_with("https://") {
        return true;
    }
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| u.starts_with(p))
}

/// 文件名只允许是**文件名**。
///
/// ⚠️ 不是洁癖：`name` 来自远端回包，`../../` 拼下去就能把文件写到可写目录之外。
/// 这一层只认「没有分隔符、没有 `..`、不是带盘符的绝对路径」。
fn safe_file_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("缺少文件名".into());
    }
    if n.contains('/') || n.contains('\\') || n.contains("..") || n.contains(':') {
        return Err(format!("文件名不合法：{n}"));
    }
    Ok(n.to_string())
}

/// 下载新版本安装包。立刻回 `{jobId}`，进度走 `job_watch`。
///
/// `args` 就是 `update_check` 回包里的 `installer`（`{name, size, url, sumsUrl}`）原样
/// 传回来，另加可选的 `version`（只用于任务标题）。
///
/// ## 地址顺序
///
/// **自建源 → 规范链接**（`crate::update::installer_candidates`）。第二档交给下载引擎，
/// 它内部会经 `ghmirror` 挑一面镜像（非 GitHub 链接原样返回）—— 与扩展包下载同一条路，
/// 不再在命令层另写一套「挑镜像」。
///
/// ## 校验
///
/// `sumsUrl` 是这次发布的 `SHA256SUMS-*.txt`（CI 生成，见 `build-installers.yml`）。
/// ⚠️ **清单与安装包走不同的路**：清单只从自建源/规范链接取（不过镜像），而安装包可能
/// 从镜像下 —— 于是「镜像把安装包换成别的」会被摘要当场抓住，这正是要校验的理由。
///
/// 有清单就**必须核对通过**（对不上就删掉下好的文件并报错）；**没有清单不算失败**
/// （老发布没有这个文件），但任务日志与回包都会写明「这次没能核对完整性」。
#[tauri::command]
pub async fn update_download(st: super::St<'_>, args: Value) -> Cmd {
    let url = args["url"].as_str().unwrap_or("").trim().to_string();
    let name = safe_file_name(args["name"].as_str().unwrap_or(""))?;
    let size = args["size"].as_u64().unwrap_or(0);
    let sums_url = args["sumsUrl"].as_str().unwrap_or("").trim().to_string();
    if !allowed_url(&url) {
        return Err(format!("下载地址不可用（只收 https）：{url}"));
    }
    let version = args["version"].as_str().unwrap_or("").trim().to_string();

    let st_arc: Arc<super::AppState> = st.inner().clone();
    let dir = updates_dir(&st_arc);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("建不了下载目录（{}）：{e}", dir.display()))?;
    let dest = dir.join(&name);

    let title = if version.is_empty() {
        format!("下载新版本 {name}")
    } else {
        format!("下载新版本 {version}")
    };
    let job_id = super::jobs::new_job(&st_arc, "update", &title);
    super::jobs::set_job(
        &st_arc,
        &job_id,
        json!({
            "meta": { "url": url, "name": name, "size": size },
            "progress": {},
            "result": Value::Null,
            "error": Value::Null,
        }),
    );

    let st2 = Arc::clone(&st_arc);
    let job2 = job_id.clone();
    tokio::spawn(async move {
        match run_download(&st2, &job2, &url, &dest, size, &sums_url).await {
            Ok((bytes, verified, sums_from)) => super::jobs::finish_with_result(
                &st2,
                &job2,
                json!({
                    "file": dest.to_string_lossy(),
                    "name": name,
                    "bytes": bytes,
                    "verified": verified,
                    "sumsFrom": sums_from,
                }),
                "下载完成，可以打开安装包了",
            ),
            Err(e) if e == CANCELED => super::jobs::set_job(
                &st2,
                &job2,
                json!({ "status": "canceled", "message": "已取消" }),
            ),
            Err(e) => super::jobs::set_job(
                &st2,
                &job2,
                json!({ "status": "error", "error": e, "message": e }),
            ),
        }
    });

    Ok(json!({ "jobId": job_id }))
}

const CANCELED: &str = "已取消";

/// 真正的下载。回 `(字节数, 核对过没有, 清单是从哪取到的)`。
async fn run_download(
    st: &Arc<super::AppState>,
    job: &str,
    url: &str,
    dest: &Path,
    size: u64,
    sums_url: &str,
) -> Result<(u64, bool, String), String> {
    // 清单先取（几百字节）：取不到就早点说「这次核对不了」，而不是等下完 150 MB。
    let sums = fetch_sums(st, job, sums_url).await;

    /* 盘上已经有一份同样大小的安装包就不重下（150 MB 重来一遍纯属浪费）。
    ⚠️ 只按字节数认出「像是同一份」，所以**必须再核对一次**；核不过就把这份删掉、
    正常往下走去重下 —— 那说明旧的那份不是这次的包（或已经坏了）。 */
    if size > 0 && std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) == size {
        super::jobs::log_job(st, job, "盘上已经有一份同样大小的安装包，直接用");
        match verify(st, job, dest, sums.as_ref()) {
            Ok((verified, from)) => return Ok((size, verified, from)),
            Err(e) => super::jobs::log_job(st, job, &format!("{e}；重下一份")),
        }
    }

    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let candidates = crate::update::installer_candidates(url);
    let mut tried: Vec<String> = Vec::new();
    let mut bytes = 0u64;
    for cand in candidates {
        match download_one(st, job, &cand, dest, size).await {
            Ok(n) => {
                bytes = n;
                break;
            }
            Err(e) if e == CANCELED => return Err(CANCELED.to_string()),
            Err(e) => {
                super::jobs::log_job(st, job, &format!("这一档没成：{e}"));
                tried.push(cand);
            }
        }
    }
    if bytes == 0 {
        return Err(format!("下载失败（试过 {} 个地址）", tried.len()));
    }

    let (verified, from) = verify(st, job, dest, sums.as_ref())?;
    let _ = file_name;
    Ok((bytes, verified, from))
}

/// 单独下一条候选地址。回写出的字节数；失败/取消回 `Err`。
async fn download_one(
    st: &Arc<super::AppState>,
    job: &str,
    cand: &str,
    dest: &Path,
    size: u64,
) -> Result<u64, String> {
    super::jobs::log_job(st, job, &format!("下载 {cand}"));
    let st_c = Arc::clone(st);
    let job_c = job.to_string();
    let cancel = move || super::jobs::is_canceled(&st_c, &job_c);
    let ctl = crate::download::Control::cancel_only(&cancel);

    let req = crate::download::Request {
        url: cand,
        label: "安装包",
        /* `Plain`：失败之后盘上不留半截文件（留下来的没有东西会去认领，下次也不会
        有人接着下）。 */
        part: dest,
        headers: &[],
        shape: crate::download::Shape::Plain,
        client: crate::download::default_client(),
        retry: crate::download::Retry::BIG_PACK,
        // 「官方大小」对不上就算这一轮失败：GitHub 偶发截断响应
        expect: (size > 0).then_some(size),
    };

    let st_p = Arc::clone(st);
    let job_p = job.to_string();
    let note = move |got: u64, total: Option<u64>, _stage: crate::download::Stage| {
        let percent = match total.filter(|t| *t > 0) {
            Some(t) => (got as f64 / t as f64 * 100.0).min(100.0),
            None => 0.0,
        };
        let message = match total.filter(|t| *t > 0) {
            Some(t) => format!(
                "已下载 {:.1} / {:.1} MB",
                got as f64 / 1048576.0,
                t as f64 / 1048576.0
            ),
            None => format!("已下载 {:.1} MB", got as f64 / 1048576.0),
        };
        super::jobs::set_job(
            &st_p,
            &job_p,
            json!({ "percent": percent, "message": message }),
        );
    };

    match crate::download::download(&req, &ctl, &note).await {
        Ok(crate::download::Outcome::Done { bytes }) => Ok(bytes),
        Ok(crate::download::Outcome::Cancelled) => Err(CANCELED.to_string()),
        // `Plain` 没有续传点，暂停与取消是同一件事（引擎已经把半截文件删了）
        Ok(crate::download::Outcome::Paused { .. }) => Err(CANCELED.to_string()),
        Err(e) => Err(e),
    }
}

/// 取校验清单：自建源 → 规范链接，**不过镜像**（清单是判据，判据不能跟被判定的一方
/// 走同一条路）。回 `(清单全文, 取到它的地址)`；一个都没取到就回 `None`。
async fn fetch_sums(
    st: &Arc<super::AppState>,
    job: &str,
    sums_url: &str,
) -> Option<(String, String)> {
    if sums_url.trim().is_empty() {
        return None;
    }
    for cand in crate::update::installer_candidates(sums_url) {
        match crate::net::fetch_bytes(&cand, crate::net::headers(&[]), 20).await {
            Ok(raw) => {
                super::jobs::log_job(st, job, &format!("取到校验清单：{cand}"));
                return Some((String::from_utf8_lossy(&raw).to_string(), cand));
            }
            Err(e) => super::jobs::log_job(st, job, &format!("取不到校验清单（{cand}）：{e}")),
        }
    }
    None
}

/// 用清单核对盘上那份。回 `(核对过没有, 清单地址)`。
///
/// - 没有清单（老发布）：回 `(false, "")`，调用方在日志里说明这次没能核对；
/// - 清单里没有这个文件：同上（发布里换了文件名）；
/// - 对不上：**删掉文件**并回 `Err` —— 半路被换过的安装包留在盘上比没有更危险。
fn verify(
    st: &Arc<super::AppState>,
    job: &str,
    dest: &Path,
    sums: Option<&(String, String)>,
) -> Result<(bool, String), String> {
    let Some((text, from)) = sums else {
        super::jobs::log_job(
            st,
            job,
            "这次没有校验清单（SHA256SUMS），下到的文件没能核对完整性",
        );
        return Ok((false, String::new()));
    };
    let file_name = dest
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let Some(want) = crate::update::expected_sha256(text, &file_name) else {
        super::jobs::log_job(st, job, "校验清单里没有这个文件，跳过核对");
        return Ok((false, from.clone()));
    };
    let got = sha256_file(dest)?;
    if got != want {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "校验不通过：安装包的 SHA-256 是 {got}，而清单里写的是 {want}。已删除下好的文件，别装它。"
        ));
    }
    super::jobs::log_job(
        st,
        job,
        &format!("SHA-256 核对通过（{}…）", want.get(..16).unwrap_or(&want)),
    );
    Ok((true, from.clone()))
}

/// 文件的 SHA-256（小写十六进制）。
///
/// 为此加了 `sha2`：`flate2` / `zip` 里那个 CRC32 能被人顺手改成一致的，挡不住
/// 「半路被换成别的安装包」，判完整性只能用密码学摘要。
fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};

    let mut file =
        std::fs::File::open(path).map_err(|e| format!("读不了 {}：{e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("读了半截：{e}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文件名来自远端回包，而它会拼进**可写目录**里：带分隔符或 `..` 的必须挡掉，
    /// 否则一次「下载」就能往可写目录之外写文件（Windows 上连盘符都能换）。
    #[test]
    fn file_names_cannot_escape_the_updates_dir() {
        assert_eq!(
            safe_file_name("v-synth-studio_1.4.2_x64-setup.exe").unwrap(),
            "v-synth-studio_1.4.2_x64-setup.exe"
        );
        for bad in [
            "../../evil.exe",
            "..\\evil.exe",
            "sub/evil.exe",
            "C:\\Windows\\evil.exe",
            "",
            "   ",
        ] {
            assert!(safe_file_name(bad).is_err(), "{bad} 不该通过");
        }
    }

    /// 只收 https；明文 http 只放行本机（自测用），与 `update::allowed_base` 同一条规矩。
    #[test]
    fn only_https_downloads_are_accepted() {
        assert!(allowed_url(
            "https://github.com/o/r/releases/download/v1/x.exe"
        ));
        assert!(allowed_url("http://127.0.0.1:8080/x.exe"));
        assert!(allowed_url("http://localhost:8080/x.exe"));
        assert!(!allowed_url("http://mirror.example.com/x.exe"));
        assert!(!allowed_url("ftp://mirror.example.com/x.exe"));
        assert!(!allowed_url(""));
    }

    /// 摘要必须**是小写十六进制、算的是文件内容**：清单里那份也是小写，
    /// 大小写不一致会把一次正确的下载判成「被换过」。
    #[test]
    fn sha256_is_lowercase_hex_of_the_file() {
        let p = std::env::temp_dir().join(format!("vss-sha-{}.bin", std::process::id()));
        std::fs::write(&p, b"").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_file(&p);
    }
}
