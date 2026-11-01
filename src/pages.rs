//! 导航页面表。页面内容先在 `app.rs` 里，后续一页页拆成独立模块。

use gpui_kit::assets::IconName;

use crate::i18n::Strings;

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

    pub fn title(self, s: &Strings) -> &'static str {
        match self {
            Self::Dashboard => s.page_dashboard,
            Self::Convert => s.page_convert,
            Self::Video => s.page_video,
            Self::Svsep => s.page_svsep,
            Self::Midi => s.page_midi,
            Self::Audio => s.page_audio,
            Self::Lyrics => s.page_lyrics,
            Self::Pv => s.page_pv,
            Self::Resources => s.page_resources,
            Self::Settings => s.page_settings,
        }
    }

    pub fn subtitle(self, s: &Strings) -> &'static str {
        match self {
            Self::Dashboard => s.sub_dashboard,
            Self::Convert => s.sub_convert,
            Self::Video => s.sub_video,
            Self::Svsep => s.sub_svsep,
            Self::Midi => s.sub_midi,
            Self::Audio => s.sub_audio,
            Self::Lyrics => s.sub_lyrics,
            Self::Pv => s.sub_pv,
            Self::Resources => s.sub_resources,
            Self::Settings => s.sub_settings,
        }
    }

    pub fn group(self, s: &Strings) -> &'static str {
        match self {
            Self::Dashboard | Self::Convert => s.group_workspace,
            Self::Video
            | Self::Svsep
            | Self::Midi
            | Self::Audio
            | Self::Lyrics
            | Self::Pv
            | Self::Resources => s.group_assets,
            Self::Settings => s.group_system,
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
