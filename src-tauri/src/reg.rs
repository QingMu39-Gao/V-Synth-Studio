//! 读注册表里的一两个值（只读 `HKCU`，只读字符串）。
//!
//! 为什么要自己写：安装器（NSIS）与程序之间需要一条**安装期就写好、程序启动时读得到**
//! 的通道，而这个程序不读任何配置文件之外的东西，注册表就是 Windows 上那条最直接的
//! 通道（见 `platform::installer_language`）。
//!
//! ⚠️ **只读、只 HKCU**：写注册表的事在安装脚本里（`nsis-hooks.nsh`），程序这一侧
//! 绝不写 —— 卸载时留下的垃圾比一个语言偏好值麻烦得多。读不到（键不存在、权限不足、
//! 值不是字符串）一律回 `None`，由调用方退回默认值。
//!
//! 用 `windows-sys` 而不是引 `winreg`：Cargo.toml 里已经有 `windows-sys`，
//! 而这里只要两个 API。

/// 打开 `HKCU\<subkey>` 读一个字符串值。读不到 / 类型不对都回 `None`。
#[cfg(windows)]
pub fn read_hkcu_string(subkey: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };

    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let sub = wide(subkey);
    let name = wide(value);

    // SAFETY: `sub` / `name` 都是以 NUL 结尾的 UTF-16，调用期间一直活着；
    // 句柄只在拿到之后用一次，并且无论成败都在这里关掉。
    unsafe {
        let mut key = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut key) != ERROR_SUCCESS {
            return None;
        }
        let mut kind = 0u32;
        let mut len = 0u32; // 字节数，含结尾的 NUL
        let status = RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            std::ptr::null_mut(),
            &mut len,
        );
        if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
            RegCloseKey(key);
            return None;
        }
        if kind != REG_SZ || len == 0 || len > 64 * 1024 {
            RegCloseKey(key);
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        let mut got = len;
        let status = RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            buf.as_mut_ptr() as *mut u8,
            &mut got,
        );
        RegCloseKey(key);
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }
}

#[cfg(not(windows))]
pub fn read_hkcu_string(_subkey: &str, _value: &str) -> Option<String> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    /// 真去读一个**安装器留下的**键：NSIS 把卸载信息写在
    /// `HKCU\...\Uninstall\<产品名>` 下，这里读它的 `Publisher` 验证这条通道能用。
    ///
    /// 这条测试**不依赖本程序装没装**：读不到就跳过（绿色版开发机上没有这个键）。
    #[test]
    fn reads_a_string_value_from_hkcu() {
        let key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\v-synth-studio";
        match super::read_hkcu_string(key, "Publisher") {
            Some(v) => {
                assert_eq!(v.to_ascii_lowercase(), "qingmu", "读到的发布者不对：{v}");
                println!("读到 Publisher = {v}");
            }
            None => eprintln!("跳过：HKCU 里没有这个键（本机没装 exe 版）"),
        }
        // 不存在的键必须回 None，而不是报错或回空串
        assert_eq!(
            super::read_hkcu_string(r"Software\qingmu\nope-not-here", "x"),
            None
        );
    }
}
