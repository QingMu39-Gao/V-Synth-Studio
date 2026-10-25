//! 导航页面表。页面内容先在 `app.rs` 里，后续一页页拆成独立模块。

use gpui_kit::assets::IconName;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Dashboard,
    Convert,
    Video,
    Svsep,
    Midi,
    Audio,
    Lyrics,
    Pv,
    Resources,
    Settings,
}

impl Page {
    pub const ALL: [Self; 10] = [
        Self::Dashboard,
        Self::Convert,
        Self::Video,
        Self::Svsep,
        Self::Midi,
        Self::Audio,
        Self::Lyrics,
        Self::Pv,
        Self::Resources,
        Self::Settings,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Dashboard => "dashboard",
            Self::Convert => "convert",
            Self::Video => "video",
            Self::Svsep => "svsep",
            Self::Midi => "midi",
            Self::Audio => "audio",
            Self::Lyrics => "lyrics",
            Self::Pv => "pv",
            Self::Resources => "resources",
            Self::Settings => "settings",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::Dashboard => "总览",
            Self::Convert => "工程转换",
            Self::Video => "视频解析",
            Self::Svsep => "音轨分离",
            Self::Midi => "人声转 MIDI",
            Self::Audio => "音频工具",
            Self::Lyrics => "网易云专栏",
            Self::Pv => "文字 PV",
            Self::Resources => "资源库",
            Self::Settings => "设置",
        }
    }

    pub fn subtitle(self) -> &'static str {
        match self {
            Self::Dashboard => "环境检测与常用入口",
            Self::Convert => "把工程转到另一个编辑器",
            Self::Video => "B 站 / YouTube 等平台的 MV 下载",
            Self::Svsep => "在线 MVSEP / 本地引擎，拆人声与伴奏",
            Self::Midi => "干声扒谱：音符起止与音高，导出 .mid",
            Self::Audio => "格式转换 / 裁剪 / 变调变速",
            Self::Lyrics => "网易云搜词，导出 LRC · SRT，下载封面 / 歌曲",
            Self::Pv => "把歌词做成动态歌词视频",
            Self::Resources => "立绘、声库、插件、音源站（仅链接）",
            Self::Settings => "外观、路径、外部工具",
        }
    }

    pub fn group(self) -> &'static str {
        match self {
            Self::Dashboard | Self::Convert => "工作台",
            Self::Video
            | Self::Svsep
            | Self::Midi
            | Self::Audio
            | Self::Lyrics
            | Self::Pv
            | Self::Resources => "素材获取",
            Self::Settings => "系统",
        }
    }

    pub fn icon(self) -> IconName {
        match self {
            Self::Dashboard => IconName::House,
            Self::Convert => IconName::ArrowLeftRight,
            Self::Video => IconName::Video,
            Self::Svsep => IconName::Layers,
            Self::Midi => IconName::AudioLines,
            Self::Audio => IconName::AudioWaveform,
            Self::Lyrics => IconName::Music,
            Self::Pv => IconName::Clapperboard,
            Self::Resources => IconName::Library,
            Self::Settings => IconName::Settings,
        }
    }
}
