//! 本机声库探测
//!
//! 移植自 Node 版 voices.mjs。数据来源两路：
//!   1. **注册表**（首选）—— VOCALOID 装声库时会登记 compID / 安装路径 / 官方名称，
//!      跟你装在哪块盘无关。这是最可靠的来源。
//!   2. **目录扫描**兜底 —— 覆盖便携版、手动拷贝的声库，以及用户手动指定的目录。
//!
//! 与 Node 版的差异：注册表用 Win32 API 直接读，不再经 PowerShell。
//! 少一层 shell，快得多，也不会受控制台代码页影响导致中文路径乱码。


use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/* ══════════════════════════════════ 常量 ══════════════════════════════════ */

/// 注册表里的声库登记位置。第二个字段表示**是否 HKCU**（否则 HKLM）。
///
/// 注意：这里的每一项已经指明了 hive，不要再和 [HKLM, HKCU] 做笛卡尔积 ——
/// 那样每条路径会被读两遍，声库数量直接翻倍（实测从 17 变成 51）。
#[cfg(windows)]
const REGISTRY_KEYS: &[(&str, bool)] = &[
    // ── HKLM：VOCALOID4/5/6 各代登记方式不同，32/64 位分支都要看
    (r"SOFTWARE\WOW6432Node\VOCALOID4\DATABASE41", false),
    (r"SOFTWARE\WOW6432Node\VOCALOID4\DATABASE", false),
    (r"SOFTWARE\VOCALOID4\DATABASE41", false),
    (r"SOFTWARE\VOCALOID4\DATABASE", false),
    (r"SOFTWARE\VOCALOID5\Voice\Components", false),
    (r"SOFTWARE\WOW6432Node\VOCALOID5\Voice\Components", false),
    (r"SOFTWARE\VOCALOID6\Application\Components", false),
    (r"SOFTWARE\WOW6432Node\VOCALOID6\Application\Components", false),
    // ── HKCU：用户级安装
    (r"SOFTWARE\VOCALOID4\DATABASE41", true),
    (r"SOFTWARE\VOCALOID4\DATABASE", true),
    (r"SOFTWARE\VOCALOID5\Voice\Components", true),
    (r"SOFTWARE\VOCALOID6\Application\Components", true),
];

/// 没有注册表信息时的兜底扫描目录
fn fallback_voice_dirs() -> Vec<PathBuf> {
    [
        "H:\\VoiceDB", "D:\\VoiceDB", "E:\\VoiceDB", "F:\\VoiceDB", "G:\\VoiceDB", "C:\\VoiceDB",
        "C:\\ProgramData\\VOCALOID6\\VoiceDB",
        "C:\\Program Files\\VOCALOID6\\VoiceDB",
        "C:\\Program Files (x86)\\VOCALOID6\\VoiceDB",
        "C:\\Program Files\\VOCALOID5\\VoiceDB",
        "D:\\VOCALOID6\\VoiceDB",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// compID 的形态：12 位以上字母数字。用来跳过 KEYS / Presets 这类非声库子键。
fn is_comp_id(s: &str) -> bool {
    s.len() >= 12 && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 名称归一化：全角转半角、转小写、去掉空格与标点
pub fn normalize_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            // 全角 ASCII 转半角
            let code = c as u32;
            if (0xFF01..=0xFF5E).contains(&code) {
                char::from_u32(code - 0xFEE0).unwrap_or(c)
            } else {
                c
            }
        })
        .collect::<String>()
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace() && !"_-./\\()（）[]【】·、,，.。:：".contains(*c))
        .collect()
}

/* ══════════════════════════════════ 用户主目录 ══════════════════════════════════ */

/// 所有可能的「用户主目录」。
///
/// 不能只信 USERPROFILE —— 在沙箱/便携环境里它可能被改写到别处，
/// 那会导致 OpenUtau 歌手、用户文档目录里的东西全部找不到。
fn candidate_homes() -> Vec<PathBuf> {
    let mut homes: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if p.is_dir() && !homes.contains(&p) {
            homes.push(p);
        }
    };

    for key in ["USERPROFILE", "HOME"] {
        if let Some(v) = std::env::var_os(key) {
            push(PathBuf::from(v));
        }
    }
    if let (Some(d), Some(p)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
        let mut s = d.to_string_lossy().to_string();
        s.push_str(&p.to_string_lossy());
        push(PathBuf::from(s));
    }

    // 枚举 C:\Users\*（跳过系统账户）
    let users_root = Path::new("C:\\Users");
    if let Ok(entries) = std::fs::read_dir(users_root) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if matches!(
                lower.as_str(),
                "public" | "default" | "default user" | "all users" | "wdagutilityaccount"
            ) {
                continue;
            }
            let full = e.path();
            if full.join("Documents").is_dir() || full.join("Desktop").is_dir() {
                push(full);
            }
        }
    }

    homes
}

/* ══════════════════════════════════ 声库条目 ══════════════════════════════════ */

#[derive(Clone)]
struct Bank {
    engine: &'static str,
    comp_id: String,
    name: String,
    group: String,
    dir: String,
    source: &'static str,
    aliases: Vec<String>,
}

impl Bank {
    fn to_json(&self) -> Value {
        json!({
            "engine": self.engine,
            "compID": self.comp_id,
            "name": self.name,
            "group": self.group,
            "dir": self.dir,
            "source": self.source,
            "aliases": self.aliases,
        })
    }
}

/// 目录里有没有声库数据文件（.ddb / .vvd / .ddi）。
///
/// 这是判断「登记项到底是不是声库」的可靠依据：
/// `HKLM\SOFTWARE\VOCALOID6\Application\Components` 里除了声库，**编辑器自己也会登记**
/// （compID `BCSPB2X3L62LZCD4`、名字 `VOCALOID6 Editor`）。只按 compID 形态过滤会把它当成声库，
/// 结果界面上多出一个假的声库条目。实测 24 个真声库都有这些文件，编辑器目录一个都没有。
fn has_voice_db(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| {
        let n = e.file_name().to_string_lossy().to_lowercase();
        n.ends_with(".ddb") || n.ends_with(".vvd") || n.ends_with(".ddi")
    })
}
/// 读目录里的 `<名字>.ddb / .vvd / .ddi` 作为声库名（注册表没给名字时的兜底）
fn ddb_name_in(dir: &Path) -> String {
    let Ok(entries) = std::fs::read_dir(dir) else { return String::new() };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        for ext in [".ddb", ".vvd", ".ddi"] {
            if lower.ends_with(ext) {
                return name[..name.len() - ext.len()].to_string();
            }
        }
    }
    String::new()
}

/// 从声库目录名推导「核心名」的别名（去掉 _V4X / _EVEC / _Original 这类后缀）
fn add_derived_aliases(aliases: &mut Vec<String>, name: &str) {
    /*
     * 按分隔符拆段，删掉纯变体词的段。
     * 词表必须和 Node 版**完全一致** —— 多列一个词就会多删一段，
     * 别名跟着变（实测多列 WARM 会让 RIN_V4X_Warm 的别名从 `rinwarm` 变成 `rin`）。
     */
    let cleaned: String = name
        .split('_')
        .filter(|part| {
            let up = part.to_uppercase();
            !matches!(
                up.as_str(),
                "V2" | "V3" | "V4X" | "EVEC" | "STRAIGHT" | "SOFT" | "WHISPER" | "ORIGINAL"
                    | "SOLID" | "DARK" | "SWEET" | "POWER" | "NATIVE" | "JPN" | "CHN" | "ENG"
            )
        })
        .collect::<Vec<_>>()
        .join("_");

    /*
     * 只产出**一个**推导别名，语义与 Node 版一致：
     * 一次性把所有变体词都删掉再归一化。
     * 「MIKU_V4X_Original_EVEC」→ 删掉 V4X / ORIGINAL / EVEC → 「miku」。
     * 早先我做了「去尾部后缀」和「按段过滤」两遍，会多冒出一个 mikuv4x。
     */
    let cand = normalize_name(&cleaned);
    if !cand.is_empty() && !aliases.contains(&cand) {
        aliases.push(cand);
    }
}

/// 读一个 compID 目录，返回声库信息
fn read_bank_dir(full: &Path, comp_id: &str, group: &str) -> Bank {
    let name = {
        let d = ddb_name_in(full);
        if d.is_empty() {
            comp_id.to_string()
        } else {
            d
        }
    };
    let mut aliases: Vec<String> = Vec::new();
    for a in [comp_id, name.as_str()] {
        let n = normalize_name(a);
        if !n.is_empty() && !aliases.contains(&n) {
            aliases.push(n);
        }
    }
    if !group.is_empty() {
        let n = normalize_name(group);
        if !n.is_empty() && !aliases.contains(&n) {
            aliases.push(n);
        }
    }
    add_derived_aliases(&mut aliases, &name);

    Bank {
        engine: "vocaloid",
        comp_id: comp_id.to_string(),
        name,
        group: group.to_string(),
        dir: full.to_string_lossy().to_string(),
        source: "目录扫描",
        aliases,
    }
}

/// 扫描一个声库根目录。支持两种真实布局：
///   `<根>\<compID>\<名字>.ddb`
///   `<根>\<声库组名>\<compID>\<名字>.ddb`
fn scan_voice_root(dir: &Path) -> Vec<Bank> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };

    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();

        if is_comp_id(&name) {
            out.push(read_bank_dir(&full, &name, ""));
            continue;
        }
        // 第二层：组名目录里再找 compID
        let Ok(subs) = std::fs::read_dir(&full) else { continue };
        for sub in subs.flatten() {
            if !sub.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let sub_name = sub.file_name().to_string_lossy().to_string();
            if is_comp_id(&sub_name) {
                out.push(read_bank_dir(&sub.path(), &sub_name, &name));
            }
        }
    }
    out
}

/* ══════════════════════════════════ 注册表读取 ══════════════════════════════════ */

#[cfg(windows)]
fn read_registry_banks() -> Vec<Bank> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ,
    };

    /// 读一个字符串值
    unsafe fn read_string(hkey: HKEY, name: &str) -> Option<String> {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut buf = vec![0u16; 2048];
        let mut len = (buf.len() * 2) as u32;
        let mut ty = 0u32;
        let rc = RegQueryValueExW(
            hkey,
            wide.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        );
        if rc != 0 || ty != REG_SZ {
            return None;
        }
        let n = (len as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..n]).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    let mut banks = Vec::new();

    for (subkey, is_hkcu) in REGISTRY_KEYS {
        // hive 由键表本身指定，不要再交叉遍历（否则每条路径读两遍，数量翻倍）
        let root = if *is_hkcu { HKEY_CURRENT_USER } else { HKEY_LOCAL_MACHINE };
        {
            let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();

            unsafe {
                // KEY_READ 默认就是当前进程视图（64 位进程看 64 位视图）；
                // WOW6432Node 那条路径本身已经指明了 32 位分支，所以不需要额外标志
                let mut hkey: HKEY = std::mem::zeroed();
                if RegOpenKeyExW(root, wide.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
                    continue;
                }

                let mut index = 0u32;
                loop {
                    let mut name_buf = vec![0u16; 512];
                    let mut name_len = name_buf.len() as u32;
                    let rc = RegEnumKeyExW(
                        hkey,
                        index,
                        name_buf.as_mut_ptr(),
                        &mut name_len,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    );
                    if rc != 0 {
                        break;
                    }
                    index += 1;

                    let comp_id = String::from_utf16_lossy(&name_buf[..name_len as usize]);
                    if !is_comp_id(&comp_id) {
                        continue;
                    }

                    // 打开子键取值
                    let child: Vec<u16> = comp_id.encode_utf16().chain(std::iter::once(0)).collect();
                    let mut chkey: HKEY = std::mem::zeroed();
                    if RegOpenKeyExW(hkey, child.as_ptr(), 0, KEY_READ, &mut chkey) != 0 {
                        continue;
                    }

                    let installed = read_string(chkey, "INSTALLED");
                    if let Some(v) = &installed {
                        if v.trim() == "0" {
                            RegCloseKey(chkey);
                            continue;
                        }
                    }

                    let base = read_string(chkey, "PATH").or_else(|| read_string(chkey, "Path"));
                    let bank_name = read_string(chkey, "BankName");
                    let raw_name = read_string(chkey, "NAME");
                    RegCloseKey(chkey);

                    let Some(base) = base else { continue };
                    let base = base.trim_end_matches(['\\', '/']).to_string();

                    // 声库目录 = 登记路径 与 compID 的组合；两者都试，取真实存在的
                    let with_id = PathBuf::from(&base).join(&comp_id);
                    let dir = if with_id.is_dir() {
                        with_id
                    } else if Path::new(&base).is_dir() {
                        PathBuf::from(&base)
                    } else {
                        with_id
                    };

                    // 名称优先级：BankName（V5/V6 的干净名）> NAME 括号里的名字（V4）> .ddb 文件名
                    let name = bank_name
                        .or_else(|| {
                            raw_name.as_ref().and_then(|n| {
                                n.rfind('(').and_then(|i| {
                                    n[i + 1..].find(')').map(|j| n[i + 1..i + 1 + j].trim().to_string())
                                })
                            })
                        })
                        .or_else(|| raw_name.clone())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| {
                            let d = ddb_name_in(&dir);
                            if d.is_empty() { comp_id.clone() } else { d }
                        });

                    // 没有声库文件的登记项不是声库（例如编辑器自己），跳过
                    if !has_voice_db(&dir) {
                        continue;
                    }

                    let mut aliases: Vec<String> = Vec::new();
                    for a in [comp_id.as_str(), name.as_str()] {
                        let n = normalize_name(a);
                        if !n.is_empty() && !aliases.contains(&n) {
                            aliases.push(n);
                        }
                    }
                    add_derived_aliases(&mut aliases, &name);

                    banks.push(Bank {
                        engine: "vocaloid",
                        comp_id: comp_id.clone(),
                        name,
                        group: String::new(),
                        dir: dir.to_string_lossy().to_string(),
                        source: "注册表",
                        aliases,
                    });
                }

                RegCloseKey(hkey);
            }
        }
    }

    /*
     * 按 compID 去重。
     * 键表里同时列了 `SOFTWARE\X` 与 `SOFTWARE\WOW6432Node\X` —— 在 64 位进程里
     * 这两条**可能指向同一处**，不去重会把同一个声库数两遍（实测 17 会变成 20）。
     */
    let mut seen: Vec<String> = Vec::new();
    banks.retain(|b| {
        if seen.contains(&b.comp_id) {
            false
        } else {
            seen.push(b.comp_id.clone());
            true
        }
    });

    banks
}

#[cfg(not(windows))]
fn read_registry_banks() -> Vec<Bank> {
    // macOS / Linux 上没有 VOCALOID，注册表更不存在
    Vec::new()
}

/* ══════════════════════════════════ 扫描与缓存 ══════════════════════════════════ */

static USER_DIRS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static CACHE: Mutex<Option<(Instant, Value)>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(5 * 60);

/// 由应用层注入用户手动指定的声库目录
pub fn set_user_dirs(dirs: &[String]) {
    if let Ok(mut g) = USER_DIRS.lock() {
        *g = dirs.to_vec();
    }
    invalidate();
}

pub fn user_dirs() -> Vec<String> {
    USER_DIRS.lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn invalidate() {
    if let Ok(mut c) = CACHE.lock() {
        *c = None;
    }
}

/// 完整快照 —— /api/state 和 /api/voices 都用它
///
/// 算法严格对齐 Node 版 getVoices()：
///   1. 先读注册表（最可靠，与安装位置无关）
///   2. 收集扫描目录：用户指定的 → 注册表声库的父目录 → 存在的兜底目录
///   3. 逐目录扫描，**第一个命中的 compID 为准**
///   4. 注册表条目覆盖同 compID 的扫描结果，并把两边的别名合并
///   5. 顺序：先目录扫描的结果，再补上只在注册表里出现的
pub fn snapshot(_config: &Value) -> Value {
    if let Ok(c) = CACHE.lock() {
        if let Some((at, data)) = c.as_ref() {
            if at.elapsed() < TTL {
                return data.clone();
            }
        }
    }

    let user = user_dirs();

    // 1) 注册表
    let registry = read_registry_banks();

    // 2) 扫描目录集合（保持插入顺序，用 Vec 去重）
    let mut scan_dirs: Vec<PathBuf> = Vec::new();
    let mut push_dir = |p: PathBuf, v: &mut Vec<PathBuf>| {
        if !p.as_os_str().is_empty() && !v.contains(&p) {
            v.push(p);
        }
    };
    for d in &user {
        push_dir(PathBuf::from(d), &mut scan_dirs);
    }
    for b in &registry {
        // 注册表给的 dir 是 `<父目录>\<compID>`，取父目录去扫
        if let Some(parent) = Path::new(&b.dir).parent() {
            push_dir(parent.to_path_buf(), &mut scan_dirs);
        }
    }
    for d in fallback_voice_dirs() {
        if d.is_dir() {
            push_dir(d, &mut scan_dirs);
        }
    }

    // 3) 逐目录扫描
    let mut scanned: Vec<String> = Vec::new();
    let mut dir_result: Vec<Bank> = Vec::new(); // 保持顺序，用 compID 去重
    let has_comp = |list: &[Bank], id: &str| list.iter().any(|b| b.comp_id == id);

    for d in &scan_dirs {
        for bank in scan_voice_root(d) {
            if !has_comp(&dir_result, &bank.comp_id) {
                dir_result.push(bank);
            }
        }
        // 目录本身也可能就是某个声库（用户直接把 compID 目录填进来了）
        let base = d.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        let tail = base.rsplit(['\\', '/']).next().unwrap_or("").to_string();
        if is_comp_id(&tail) && d.is_dir() && !has_comp(&dir_result, &tail) {
            dir_result.push(read_bank_dir(d, &tail, ""));
        }
        scanned.push(d.to_string_lossy().to_string());
    }

    // 4) 注册表覆盖 + 合并别名
    let mut merged: Vec<Bank> = dir_result;
    for bank in registry.iter() {
        match merged.iter_mut().find(|b| b.comp_id == bank.comp_id) {
            Some(prev) => {
                let prev_aliases = prev.aliases.clone();
                let prev_dir = prev.dir.clone();
                *prev = bank.clone();
                // 注册表给了名字就用注册表的；目录里的 .ddb 名字作为别名补充
                let mut aliases = prev_aliases;
                for a in bank.aliases.iter().chain([
                    &normalize_name(&bank.comp_id),
                    &normalize_name(&bank.name),
                ]) {
                    if !a.is_empty() && !aliases.contains(a) {
                        aliases.push(a.clone());
                    }
                }
                prev.aliases = aliases;
                if prev.dir.is_empty() {
                    prev.dir = prev_dir;
                }
            }
            None => merged.push(bank.clone()),
        }
    }

    let openutau = scan_openutau_singers();
    let synthv = scan_synthv();

    let vocaloid: Vec<Value> = merged.iter().map(|b| b.to_json()).collect();
    let total = vocaloid.len() + openutau.len() + synthv.len();

    let result = json!({
        "scannedAt": iso_now(),
        // 「最终结果里有几个来自注册表登记」。
        // 不用 registry.len()：那会把重复登记与编辑器条目也算进去，口径不清。
        // Node 版报的也是这个含义（17）。
        "registryCount": vocaloid
            .iter()
            .filter(|b| b.get("source").and_then(|s| s.as_str()) == Some("注册表"))
            .count(),
        "scannedDirs": scanned,
        "userDirs": user,
        "vocaloid": vocaloid,
        "openutau": openutau,
        "synthv": synthv,
        "total": total,
        "hint": if merged.is_empty() {
            "没检测到 VOCALOID 声库。正常安装的声库会登记到注册表，一般都能自动识别；\
             便携版或手动拷贝的声库请在「设置 → 声库目录」里指定它所在的根目录。"
        } else {
            ""
        },
    });

    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), result.clone()));
    }
    result
}

fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let rem = secs % 86400;
    format!(
        "{}T{:02}:{:02}:{:02}.000Z",
        days_since_epoch_to_date(days as i64),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn days_since_epoch_to_date(z: i64) -> String {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

/// OpenUtau 歌手目录
fn scan_openutau_singers() -> Vec<Value> {
    let mut out = Vec::new();
    for home in candidate_homes() {
        for sub in ["Documents/OpenUtau/Singers", "OpenUtau/Singers"] {
            let dir = home.join(sub);
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let comp_id = e.file_name().to_string_lossy().to_string();
                // 歌手显示名优先取 character.txt / character.yaml 里的 name 字段
                let name = read_character_name(&e.path()).unwrap_or_else(|| comp_id.clone());
                let mut aliases: Vec<String> = Vec::new();
                for a in [comp_id.as_str(), name.as_str()] {
                    let n = normalize_name(a);
                    if !n.is_empty() && !aliases.contains(&n) {
                        aliases.push(n);
                    }
                }
                out.push(json!({
                    "engine": "openutau",
                    "compID": comp_id,
                    "name": name,
                    "dir": e.path().to_string_lossy(),
                    "source": "OpenUtau 歌手目录",
                    "aliases": aliases,
                }));
            }
        }
    }
    out
}

/// 从 character.txt / character.yaml 里读歌手显示名。
/// 格式很简单（`name: X` 或 `name = X`），不值得为它引一个 YAML 库。
fn read_character_name(dir: &Path) -> Option<String> {
    for file in ["character.txt", "character.yaml"] {
        let Ok(text) = std::fs::read_to_string(dir.join(file)) else { continue };
        for line in text.lines() {
            let trimmed = line.trim();
            let lower = trimmed.to_lowercase();
            if !lower.starts_with("name") {
                continue;
            }
            // 必须是 name 这个键（后面跟 : 或 =），不能是 nameXXX
            let rest = &trimmed[4..];
            let Some(sep) = rest.find([':', '=']) else { continue };
            if sep > 1 {
                continue;
            }
            let value = rest[sep + 1..].trim().trim_matches('"').trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Synthesizer V 声库目录
fn scan_synthv() -> Vec<Value> {
    let mut out = Vec::new();
    for home in candidate_homes() {
        let dir = home.join("Documents/Synthesizer V Studio/voices");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            out.push(json!({
                "engine": "synthv",
                "name": name,
                "dir": e.path().to_string_lossy(),
                "source": "目录扫描",
                "aliases": [normalize_name(&name)],
            }));
        }
    }
    out
}

/* ══════════════════════════════════ 歌手名匹配 ══════════════════════════════════ */

/// 简繁对照（只列声库名里会出现的字）
const TRAD_TO_SIMP: &[(&str, &str)] = &[
    ("鏡", "镜"), ("鈴", "铃"), ("連", "连"), ("音", "音"), ("初", "初"),
    ("巡", "巡"), ("咲", "咲"), ("結", "结"), ("月", "月"), ("芽", "芽"),
    ("衣", "衣"), ("風", "风"), ("香", "香"), ("弱", "弱"), ("音", "音"),
];

fn trad_to_simp(s: &str) -> String {
    s.chars()
        .map(|c| {
            let cs = c.to_string();
            for (t, s2) in TRAD_TO_SIMP {
                if cs == *t {
                    return s2.chars().next().unwrap_or(c);
                }
            }
            c
        })
        .collect()
}

/// 歌手别名表：把各种写法映射到统一的规范名
const SINGER_ALIASES: &[(&str, &[&str])] = &[
    ("miku", &["hatsune miku", "初音ミク", "初音未来", "miku"]),
    ("rin", &["kagamine rin", "鏡音リン", "镜音リン", "镜音铃", "rin"]),
    ("len", &["kagamine len", "鏡音レン", "镜音レン", "镜音连", "len"]),
    ("luka", &["megurine luka", "巡音ルカ", "巡音露卡", "luka"]),
    ("kaito", &["kaito", "カイト"]),
    ("meiko", &["meiko", "メイコ"]),
    ("gumi", &["gumi", "グミ"]),
    ("luotianyi", &["luo tianyi", "洛天依", "天依"]),
    ("yuezhengling", &["yuezheng ling", "乐正绫", "樂正綾"]),
    ("yanhe", &["yan he", "言和"]),
    ("ia", &["ia", "イア"]),
    ("yukari", &["yuzuki yukari", "結月ゆかり", "结月缘"]),
];

/// 取声库名的「核心名」：去掉版本号与变体后缀
pub fn core_name(name: &str) -> String {
    let n = normalize_name(name);
    // 去掉结尾的 v4x / v3 / ver2 之类
    let mut s = n.clone();
    for suffix in ["v4x", "v3", "v2", "ver4", "ver3", "ver2"] {
        if s.ends_with(suffix) {
            s.truncate(s.len() - suffix.len());
        }
    }
    s
}

/// 把歌手名归一成规范名（用于跨语言/繁简/全半角匹配）
pub fn canonical_singer(name: &str) -> String {
    let simp = trad_to_simp(name);
    let norm = normalize_name(&simp);
    if norm.is_empty() {
        return String::new();
    }
    for (canon, variants) in SINGER_ALIASES {
        for v in *variants {
            let nv = normalize_name(v);
            if nv.is_empty() {
                continue;
            }
            /*
             * 子串匹配必须对**被查找的那一方**做长度检查，两个方向都要。
             *
             * 实测踩过的坑：`IA` 是 `Luo-t-i-a-nyi` 的子串。
             * 只检查一边的话，`nv.contains(norm)` 会让短名 "ia" 命中长名 "luotianyi"，
             * 于是 IA 被认成洛天依的声库。日文歌手名里两字母缩写很多，这个约束必须留着。
             */
            if norm == nv {
                return (*canon).to_string();
            }
            if nv.len() >= 3 && norm.contains(&nv) {
                return (*canon).to_string();
            }
            if norm.len() >= 3 && nv.contains(&norm) {
                return (*canon).to_string();
            }
        }
    }
    norm
}

/// 按歌手名匹配本机声库。
///
/// 返回 `{matched, compID, bankName, score, reason}`
pub fn match_singer_in(singer: &str, banks: &[Value]) -> Value {
    if singer.trim().is_empty() {
        return json!({ "matched": false, "reason": "歌手名为空" });
    }
    let want_canon = canonical_singer(singer);
    let want_norm = normalize_name(singer);
    let want_core = core_name(singer);

    let mut best: Option<(i32, &Value, &'static str)> = None;

    for bank in banks {
        let name = bank.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let comp_id = bank.get("compID").and_then(|v| v.as_str()).unwrap_or("");
        let dir = bank.get("dir").and_then(|v| v.as_str()).unwrap_or("");
        let aliases: Vec<String> = bank
            .get("aliases")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let bank_norm = normalize_name(name);
        let bank_canon = canonical_singer(name);
        let mut score = 0i32;
        let mut reason = "";

        // 别名精确命中
        if aliases.iter().any(|a| *a == want_norm) {
            score = 100;
            reason = "别名精确匹配";
        } else if !want_canon.is_empty() && bank_canon == want_canon && want_canon.len() >= 3 {
            score = 90;
            reason = "规范名匹配";
        } else if want_core.len() >= 3 && bank_norm.contains(&want_core) {
            score = 70;
            reason = "名称包含";
        } else if want_norm.len() >= 3 && bank_norm.contains(&want_norm) {
            score = 60;
            reason = "名称部分匹配";
        }

        if score == 0 {
            continue;
        }

        // 语言加成：中文歌手优先挑中文声库（路径里常带 CHN）
        let want_is_cn = is_chinese(singer);
        let bank_is_cn = is_chinese(name) || dir.to_lowercase().contains("chn");
        if want_is_cn && !bank_is_cn {
            score -= 15;
        } else if want_is_cn && bank_is_cn {
            score += 10;
        }
        let _ = comp_id;

        if best.as_ref().map(|(s, _, _)| score > *s).unwrap_or(true) {
            best = Some((score, bank, reason));
        }
    }

    match best {
        Some((score, bank, reason)) => json!({
            "matched": true,
            "compID": bank.get("compID"),
            "bankName": bank.get("name"),
            "score": score,
            "reason": reason,
        }),
        None => json!({
            "matched": false,
            "reason": "本机没有找到对应声库",
        }),
    }
}

fn is_chinese(s: &str) -> bool {
    s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
}

/// /api/voices/match 的入口。
/// 匹配池包含全部引擎的声库 —— 用户的工程里歌手可能来自 OpenUtau 或 SynthV。
pub fn match_singer(singer: &str) -> Value {
    let snap = snapshot(&json!({}));
    let mut banks: Vec<Value> = Vec::new();
    for key in ["vocaloid", "openutau", "synthv"] {
        if let Some(arr) = snap.get(key).and_then(|v| v.as_array()) {
            banks.extend(arr.iter().cloned());
        }
    }
    match_singer_in(singer, &banks)
}

/// /api/voices/probe 的入口：试探一个目录里有多少声库
pub fn probe_dir(dir: &str) -> Value {
    let path = Path::new(dir);
    if !path.is_dir() {
        return json!({ "found": 0, "vocaloid": [], "openutau": [], "synthv": [], "totalAfterAdd": 0 });
    }
    let banks = scan_voice_root(path);
    json!({
        "found": banks.len(),
        "vocaloid": banks.iter().map(|b| json!({ "name": b.name, "compID": b.comp_id })).collect::<Vec<_>>(),
        "openutau": [],
        "synthv": [],
        "totalAfterAdd": snapshot(&json!({})).get("total").cloned().unwrap_or(json!(0)),
    })
}
