//! Project formats exposed by the conversion page. The identifier is the file
//! extension passed to LibreSVIP; the CLI infers input and output plugins from it.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub id: &'static str,
    pub name: &'static str,
    pub extensions: &'static [&'static str],
}

pub const ALL: &[Format] = &[
    Format {
        id: "svp",
        name: "Synthesizer V",
        extensions: &["svp"],
    },
    Format {
        id: "vsqx",
        name: "VOCALOID",
        extensions: &["vsqx"],
    },
    Format {
        id: "vpr",
        name: "VOCALOID 6",
        extensions: &["vpr"],
    },
    Format {
        id: "ust",
        name: "UTAU",
        extensions: &["ust"],
    },
    Format {
        id: "ustx",
        name: "OpenUtau",
        extensions: &["ustx"],
    },
    Format {
        id: "ccs",
        name: "CeVIO",
        extensions: &["ccs"],
    },
    Format {
        id: "mid",
        name: "MIDI",
        extensions: &["mid", "midi"],
    },
    Format {
        id: "musicxml",
        name: "MusicXML",
        extensions: &["musicxml", "xml", "mxl"],
    },
    Format {
        id: "json",
        name: "OpenSVIP",
        extensions: &["json"],
    },
    Format {
        id: "acep",
        name: "ACE Studio",
        extensions: &["acep", "acet"],
    },
    Format {
        id: "aisp",
        name: "AISingers",
        extensions: &["aisp"],
    },
    Format {
        id: "dspx",
        name: "DiffScope",
        extensions: &["dspx"],
    },
    Format {
        id: "s5p",
        name: "SynthV Editor",
        extensions: &["s5p"],
    },
    Format {
        id: "ppsf",
        name: "Piapro Studio",
        extensions: &["ppsf"],
    },
    Format {
        id: "vvproj",
        name: "VOICEVOX",
        extensions: &["vvproj"],
    },
    Format {
        id: "mtp",
        name: "Muta",
        extensions: &["mtp"],
    },
    Format {
        id: "dv",
        name: "DeepVocal",
        extensions: &["dv", "sk"],
    },
    Format {
        id: "nn",
        name: "NIAONiao",
        extensions: &["nn"],
    },
    Format {
        id: "ass",
        name: "ASS subtitles",
        extensions: &["ass"],
    },
    Format {
        id: "lrc",
        name: "LRC lyrics",
        extensions: &["lrc"],
    },
    Format {
        id: "srt",
        name: "SRT subtitles",
        extensions: &["srt"],
    },
    Format {
        id: "ufdata",
        name: "UtaFormatix",
        extensions: &["ufdata"],
    },
    Format {
        id: "ace",
        name: "ACE Virtual Singer",
        extensions: &["ace"],
    },
    Format {
        id: "ds",
        name: "DiffSinger",
        extensions: &["ds"],
    },
    Format {
        id: "ps_project",
        name: "Pocket Singer",
        extensions: &["ps_project"],
    },
    Format {
        id: "svg",
        name: "SVG",
        extensions: &["svg"],
    },
    Format {
        id: "svip",
        name: "X Studio",
        extensions: &["svip"],
    },
    Format {
        id: "svip3",
        name: "X Studio (NetEase)",
        extensions: &["svip3"],
    },
    Format {
        id: "tlp",
        name: "TuneLab (legacy)",
        extensions: &["tlp"],
    },
    Format {
        id: "tlpx",
        name: "TuneLab",
        extensions: &["tlpx"],
    },
    Format {
        id: "tsmsln",
        name: "Techno-Speech Mobile",
        extensions: &["tsmsln"],
    },
    Format {
        id: "tssln",
        name: "Techno-Speech",
        extensions: &["tssln"],
    },
    Format {
        id: "vfp",
        name: "VOX Factory",
        extensions: &["vfp"],
    },
    Format {
        id: "vog",
        name: "Vogen",
        extensions: &["vog"],
    },
    Format {
        id: "vshp",
        name: "VocalShifter",
        extensions: &["vshp"],
    },
    Format {
        id: "vspx",
        name: "VocalSharp",
        extensions: &["vspx"],
    },
    Format {
        id: "vsq",
        name: "VOCALOID 2",
        extensions: &["vsq"],
    },
    Format {
        id: "vxf",
        name: "VX-β",
        extensions: &["vxf"],
    },
    Format {
        id: "xvsq",
        name: "Cadencii",
        extensions: &["xvsq"],
    },
    Format {
        id: "y77",
        name: "Yuan Qiqi",
        extensions: &["y77"],
    },
];

pub const DEFAULT: &Format = &ALL[0];

pub const PICK_EXTENSIONS: &[&str] = &[
    "svp",
    "vsqx",
    "vpr",
    "ust",
    "ustx",
    "ccs",
    "mid",
    "midi",
    "musicxml",
    "xml",
    "mxl",
    "json",
    "ace",
    "acep",
    "acet",
    "aisp",
    "dspx",
    "s5p",
    "ppsf",
    "vvproj",
    "mtp",
    "dv",
    "sk",
    "nn",
    "ass",
    "lrc",
    "srt",
    "ufdata",
    "ds",
    "ps_project",
    "svg",
    "svip",
    "svip3",
    "tlp",
    "tlpx",
    "tsmsln",
    "tssln",
    "vfp",
    "vog",
    "vshp",
    "vspx",
    "vsq",
    "vxf",
    "xvsq",
    "y77",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_common_formats_once() {
        assert_eq!(ALL.len(), 40);
        assert!(ALL.iter().any(|format| format.id == "svp"));
        assert!(ALL.iter().any(|format| format.id == "ufdata"));
        let mut ids = ALL.iter().map(|format| format.id).collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), ALL.len());
    }
}
