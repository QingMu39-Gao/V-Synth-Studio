import {useSyncExternalStore} from 'react'
import {getConfig, onConfigChange, saveConfig} from './config'

export type UiLanguage = 'zh-CN' | 'en-US' | 'ja-JP'

/* 导出是为了让测试能核「每个词条三语齐全」—— 漏一列不会报错，只会在那个语言的界面里
   静默显示中文。 */
export const DICT: Record<string, Record<UiLanguage, string>> = {
    '总览': {'zh-CN': '总览', 'en-US': 'Dashboard', 'ja-JP': '概要'},
    '环境检测与常用入口': {
        'zh-CN': '环境检测与常用入口',
        'en-US': 'Environment checks and quick actions',
        'ja-JP': '環境チェックとクイック操作'
    },
    '工程转换': {'zh-CN': '工程转换', 'en-US': 'Project Converter', 'ja-JP': 'プロジェクト変換'},
    '把工程转到另一个编辑器': {
        'zh-CN': '把工程转到另一个编辑器',
        'en-US': 'Convert projects between editors',
        'ja-JP': '別のエディター向けにプロジェクトを変換'
    },
    '视频解析': {'zh-CN': '视频解析', 'en-US': 'Video Downloader', 'ja-JP': '動画解析'},
    'B 站 / YouTube 等平台的 MV 下载': {
        'zh-CN': 'B 站 / YouTube 等平台的 MV 下载',
        'en-US': 'Download MV from Bilibili, YouTube and more',
        'ja-JP': 'Bilibili・YouTube などから MV をダウンロード'
    },
    '音轨分离': {'zh-CN': '音轨分离', 'en-US': 'Stem Separation', 'ja-JP': 'ステム分離'},
    '人声转 MIDI': {'zh-CN': '人声转 MIDI', 'en-US': 'Vocal to MIDI', 'ja-JP': 'ボーカル→MIDI'},
    '音频工具': {'zh-CN': '音频工具', 'en-US': 'Audio Tools', 'ja-JP': 'オーディオツール'},
    '网易云专栏': {'zh-CN': '网易云专栏', 'en-US': 'Netease Music', 'ja-JP': 'NetEase Music'},
    '文字 PV': {'zh-CN': '文字 PV', 'en-US': 'Lyric PV', 'ja-JP': '歌詞 PV'},
    '资源库': {'zh-CN': '资源库', 'en-US': 'Resources', 'ja-JP': 'リソース'},
    '设置': {'zh-CN': '设置', 'en-US': 'Settings', 'ja-JP': '設定'},
    '外观': {'zh-CN': '外观', 'en-US': 'Appearance', 'ja-JP': '外観'},
    '壁纸': {'zh-CN': '壁纸', 'en-US': 'Wallpaper', 'ja-JP': '壁紙'},
    '路径': {'zh-CN': '路径', 'en-US': 'Paths', 'ja-JP': 'パス'},
    '外部工具': {'zh-CN': '外部工具', 'en-US': 'External Tools', 'ja-JP': '外部ツール'},
    '关于': {'zh-CN': '关于', 'en-US': 'About', 'ja-JP': '概要'},
    '工作台': {'zh-CN': '工作台', 'en-US': 'Workspace', 'ja-JP': 'ワークスペース'},
    '素材获取': {'zh-CN': '素材获取', 'en-US': 'Assets', 'ja-JP': '素材'},
    '系统': {'zh-CN': '系统', 'en-US': 'System', 'ja-JP': 'システム'},
    '设置分节': {'zh-CN': '设置分节', 'en-US': 'Settings sections', 'ja-JP': '設定セクション'},
    '主题': {'zh-CN': '主题', 'en-US': 'Theme', 'ja-JP': 'テーマ'},
    '跟随系统': {'zh-CN': '跟随系统', 'en-US': 'System', 'ja-JP': 'システム'},
    '明亮': {'zh-CN': '明亮', 'en-US': 'Light', 'ja-JP': 'ライト'},
    '黑暗': {'zh-CN': '黑暗', 'en-US': 'Dark', 'ja-JP': 'ダーク'},
    '整套界面的配色': {
        'zh-CN': '整套界面的配色',
        'en-US': 'Color scheme for the entire interface',
        'ja-JP': 'インターフェース全体の配色'
    },
    '语言': {'zh-CN': '语言', 'en-US': 'Language', 'ja-JP': '言語'},
    '简体中文': {'zh-CN': '简体中文', 'en-US': 'Simplified Chinese', 'ja-JP': '簡体字中国語'},
    'English': {'zh-CN': 'English', 'en-US': 'English', 'ja-JP': '英語'},
    '日本語': {'zh-CN': '日本語', 'en-US': 'Japanese', 'ja-JP': '日本語'},
    '已选': {'zh-CN': '已选', 'en-US': 'Selected', 'ja-JP': '選択中'},
    '玻璃等级': {'zh-CN': '玻璃等级', 'en-US': 'Glass level', 'ja-JP': 'ガラスレベル'},
    '级别越高越「玻璃」，开销也越大': {
        'zh-CN': '级别越高越「玻璃」，开销也越大',
        'en-US': 'Higher levels use stronger glass effects and more resources',
        'ja-JP': 'レベルが高いほどガラス効果が強くなり、負荷も増えます'
    },
    '选择应用界面语言': {
        'zh-CN': '选择应用界面语言',
        'en-US': 'Choose the application interface language',
        'ja-JP': 'アプリの表示言語を選択'
    },
    '系统切换配色时自动跟着换': {
        'zh-CN': '系统切换配色时自动跟着换',
        'en-US': 'Follow the system color scheme',
        'ja-JP': 'システムの配色に合わせる'
    },
    '浅色底、细描边': {
        'zh-CN': '浅色底、细描边',
        'en-US': 'Light background with subtle borders',
        'ja-JP': '明るい背景と細い境界線'
    },
    '深色底，长时间看不刺眼': {
        'zh-CN': '深色底，长时间看不刺眼',
        'en-US': 'Dark background for comfortable long sessions',
        'ja-JP': '長時間でも見やすいダークテーマ'
    },
    '等级只影响材质，背景图不变。': {
        'zh-CN': '等级只影响材质，背景图不变。',
        'en-US': 'The level only affects the material; the wallpaper stays unchanged.',
        'ja-JP': 'レベルはマテリアルのみ変更し、壁紙は変わりません。'
    },
    "来源工程": {'zh-CN': "来源工程", 'en-US': "Source project", 'ja-JP': "ソースプロジェクト"},
    "把工程文件拖到这里": {
        'zh-CN': "把工程文件拖到这里",
        'en-US': "Drop project files here",
        'ja-JP': "ここにプロジェクトファイルをドロップ"
    },
    "还没有添加文件": {
        'zh-CN': "还没有添加文件",
        'en-US': "No files added yet",
        'ja-JP': "ファイルがまだ追加されていません"
    },
    "目标格式": {'zh-CN': "目标格式", 'en-US': "Target format", 'ja-JP': "変換先形式"},
    "还没有读到可用的格式。": {
        'zh-CN': "还没有读到可用的格式。",
        'en-US': "No usable formats found.",
        'ja-JP': "利用可能な形式が見つかりません。"
    },
    "输出设置": {'zh-CN': "输出设置", 'en-US': "Output settings", 'ja-JP': "出力設定"},
    "选输出目录": {'zh-CN': "选输出目录", 'en-US': "Choose output directory", 'ja-JP': "出力先フォルダーを選択"},
    "转换选项": {'zh-CN': "转换选项", 'en-US': "Conversion options", 'ja-JP': "変換オプション"},
    "导入（默认全开）": {
        'zh-CN': "导入（默认全开）",
        'en-US': "Import (all enabled by default)",
        'ja-JP': "インポート（既定ですべて有効）"
    },
    "效果处理（默认全关）": {
        'zh-CN': "效果处理（默认全关）",
        'en-US': "Effects (disabled by default)",
        'ja-JP': "エフェクト（既定では無効）"
    },
    "音高变调半音数": {'zh-CN': "音高变调半音数", 'en-US': "Pitch shift (semitones)", 'ja-JP': "ピッチ変更（半音）"},
    "导出（只对支持这些开关的目标格式有意义）": {
        'zh-CN': "导出（只对支持这些开关的目标格式有意义）",
        'en-US': "Export (only supported by the target format)",
        'ja-JP': "エクスポート（変換先が対応する場合のみ有効）"
    },
    "转换预检": {'zh-CN': "转换预检", 'en-US': "Conversion preflight", 'ja-JP': "変換前チェック"},
    "这批文件都读不了": {
        'zh-CN': "这批文件都读不了",
        'en-US': "None of these files can be read",
        'ja-JP': "このファイル群は読み込めません"
    },
    "目标格式装不下下列数据，转换后会丢失：": {
        'zh-CN': "目标格式装不下下列数据，转换后会丢失：",
        'en-US': "The target format cannot represent the following data; it will be lost:",
        'ja-JP': "変換先形式で次のデータを保持できないため、変換後に失われます："
    },
    "预检通过": {'zh-CN': "预检通过", 'en-US': "Preflight passed", 'ja-JP': "事前チェック成功"},
    "读取失败": {'zh-CN': "读取失败", 'en-US': "Read failed", 'ja-JP': "読み込み失敗"},
    "预检失败": {'zh-CN': "预检失败", 'en-US': "Preflight failed", 'ja-JP': "事前チェック失敗"},
    "解析视频": {'zh-CN': "解析视频", 'en-US': "Parse video", 'ja-JP': "動画を解析"},
    "回车即解析": {'zh-CN': "回车即解析", 'en-US': "Press Enter to parse", 'ja-JP': "Enterキーで解析"},
    "视频链接": {'zh-CN': "视频链接", 'en-US': "Video URL", 'ja-JP': "動画URL"},
    "从剪贴板读链接": {
        'zh-CN': "从剪贴板读链接",
        'en-US': "Read URL from clipboard",
        'ja-JP': "クリップボードからURLを読み込む"
    },
    "未安装 ffmpeg": {
        'zh-CN': "未安装 ffmpeg",
        'en-US': "ffmpeg is not installed",
        'ja-JP': "ffmpegがインストールされていません"
    },
    "未安装 yt-dlp": {
        'zh-CN': "未安装 yt-dlp",
        'en-US': "yt-dlp is not installed",
        'ja-JP': "yt-dlpがインストールされていません"
    },
    "正在解析视频信息…": {
        'zh-CN': "正在解析视频信息…",
        'en-US': "Parsing video information…",
        'ja-JP': "動画情報を解析中…"
    },
    "解析失败": {'zh-CN': "解析失败", 'en-US': "Parsing failed", 'ja-JP': "解析に失敗しました"},
    "这个站点需要 yt-dlp": {
        'zh-CN': "这个站点需要 yt-dlp",
        'en-US': "This site requires yt-dlp",
        'ja-JP': "このサイトにはyt-dlpが必要です"
    },
    "还没有解析任何视频": {
        'zh-CN': "还没有解析任何视频",
        'en-US': "No video has been parsed yet",
        'ja-JP': "まだ動画を解析していません"
    },
    "解析结果": {'zh-CN': "解析结果", 'en-US': "Parse result", 'ja-JP': "解析結果"},
    "视频简介": {'zh-CN': "视频简介", 'en-US': "Video description", 'ja-JP': "動画説明"},
    "番剧": {'zh-CN': "番剧", 'en-US': "Series", 'ja-JP': "シリーズ"},
    "未登录": {'zh-CN': "未登录", 'en-US': "Not logged in", 'ja-JP': "未ログイン"},
    "已登录": {'zh-CN': "已登录", 'en-US': "Logged in", 'ja-JP': "ログイン済み"},
    "内容": {'zh-CN': "内容", 'en-US': "Content", 'ja-JP': "コンテンツ"},
    "内容分组": {'zh-CN': "内容分组", 'en-US': "Content groups", 'ja-JP': "コンテンツグループ"},
    "没有取到播放流信息": {
        'zh-CN': "没有取到播放流信息",
        'en-US': "No playback stream information",
        'ja-JP': "再生ストリーム情報を取得できません"
    },
    "无法获取画质列表": {
        'zh-CN': "无法获取画质列表",
        'en-US': "Unable to get quality list",
        'ja-JP': "画質一覧を取得できません"
    },
    "播放流（整段）": {'zh-CN': "播放流（整段）", 'en-US': "Playback stream (full)", 'ja-JP': "再生ストリーム（全体）"},
    "整段流模式": {'zh-CN': "整段流模式", 'en-US': "Full-stream mode", 'ja-JP': "全体ストリームモード"},
    "画质受限：未登录": {
        'zh-CN': "画质受限：未登录",
        'en-US': "Quality limited: not logged in",
        'ja-JP': "画質制限：未ログイン"
    },
    "视频流": {'zh-CN': "视频流", 'en-US': "Video stream", 'ja-JP': "動画ストリーム"},
    "仅音频：不下载视频流": {
        'zh-CN': "仅音频：不下载视频流",
        'en-US': "Audio only: don't download video stream",
        'ja-JP': "音声のみ：動画ストリームをダウンロードしない"
    },
    "没有视频流": {'zh-CN': "没有视频流", 'en-US': "No video stream", 'ja-JP': "動画ストリームなし"},
    "音频流": {'zh-CN': "音频流", 'en-US': "Audio stream", 'ja-JP': "音声ストリーム"},
    "没有音频流": {'zh-CN': "没有音频流", 'en-US': "No audio stream", 'ja-JP': "音声ストリームなし"},
    "番剧画质": {'zh-CN': "番剧画质", 'en-US': "Series quality", 'ja-JP': "シリーズ画質"},
    "可选格式": {'zh-CN': "可选格式", 'en-US': "Available formats", 'ja-JP': "利用可能な形式"},
    "没有可用格式": {'zh-CN': "没有可用格式", 'en-US': "No available formats", 'ja-JP': "利用可能な形式がありません"},
    "官方字幕": {'zh-CN': "官方字幕", 'en-US': "Official subtitles", 'ja-JP': "公式字幕"},
    "预览": {'zh-CN': "预览", 'en-US': "Preview", 'ja-JP': "プレビュー"},
    "下载选项": {'zh-CN': "下载选项", 'en-US': "Download options", 'ja-JP': "ダウンロード設定"},
    "选下载到哪个目录": {
        'zh-CN': "选下载到哪个目录",
        'en-US': "Choose download directory",
        'ja-JP': "ダウンロード先フォルダーを選択"
    },
    "下载模式": {'zh-CN': "下载模式", 'en-US': "Download mode", 'ja-JP': "ダウンロードモード"},
    "下载音质": {
        'zh-CN': "下载音质",
        'en-US': "Download quality",
        'ja-JP': "ダウンロード音質"
    },
    "下载队列": {'zh-CN': "下载队列", 'en-US': "Download queue", 'ja-JP': "ダウンロードキュー"},
    "音频素材": {'zh-CN': "音频素材", 'en-US': "Audio source", 'ja-JP': "音声素材"},
    "未选": {'zh-CN': "未选", 'en-US': "Not selected", 'ja-JP': "未選択"},
    "分离模式": {'zh-CN': "分离模式", 'en-US': "Separation mode", 'ja-JP': "分離モード"},
    "分离完做什么": {'zh-CN': "分离完做什么", 'en-US': "After separation", 'ja-JP': "分離後の処理"},
    "离线引擎": {'zh-CN': "离线引擎", 'en-US': "Offline engine", 'ja-JP': "オフラインエンジン"},
    "运行中": {'zh-CN': "运行中", 'en-US': "Running", 'ja-JP': "実行中"},
    "空闲": {'zh-CN': "空闲", 'en-US': "Idle", 'ja-JP': "待機中"},
    "安装失败": {'zh-CN': "安装失败", 'en-US': "Installation failed", 'ja-JP': "インストール失敗"},
    "推理方式": {'zh-CN': "推理方式", 'en-US': "Inference mode", 'ja-JP': "推論方式"},
    "上次启动失败": {'zh-CN': "上次启动失败", 'en-US': "Last startup failed", 'ja-JP': "前回の起動に失敗しました"},
    "读不到分离状态": {
        'zh-CN': "读不到分离状态",
        'en-US': "Cannot read separation status",
        'ja-JP': "分離状態を読み取れません"
    },
    "分离进度": {'zh-CN': "分离进度", 'en-US': "Separation progress", 'ja-JP': "分離の進捗"},
    "待提交": {'zh-CN': "待提交", 'en-US': "Pending", 'ja-JP': "待機中"},
    "分离失败": {'zh-CN': "分离失败", 'en-US': "Separation failed", 'ja-JP': "分離に失敗しました"},
    "没有分离出结果": {'zh-CN': "没有分离出结果", 'en-US': "No separation results", 'ja-JP': "分離結果がありません"},
    "在线分离：MVSEP": {'zh-CN': "在线分离：MVSEP", 'en-US': "Online separation: MVSEP", 'ja-JP': "オンライン分離：MVSEP"},
    "需上传": {'zh-CN': "需上传", 'en-US': "Upload required", 'ja-JP': "アップロードが必要"},
    "隐私提示": {'zh-CN': "隐私提示", 'en-US': "Privacy notice", 'ja-JP': "プライバシーに関する注意"},
    "引擎队列": {'zh-CN': "引擎队列", 'en-US': "Engine queue", 'ja-JP': "エンジンキュー"},
    "结果": {'zh-CN': "结果", 'en-US': "Result", 'ja-JP': "結果"},
    "已写出": {'zh-CN': "已写出", 'en-US': "Written", 'ja-JP': "出力済み"},
    "起点": {'zh-CN': "起点", 'en-US': "Start", 'ja-JP': "開始位置"},
    "时长": {'zh-CN': "时长", 'en-US': "Duration", 'ja-JP': "長さ"},
    "音高": {'zh-CN': "音高", 'en-US': "Pitch", 'ja-JP': "音高"},
    "干声素材": {'zh-CN': "干声素材", 'en-US': "Dry vocal", 'ja-JP': "ドライボーカル"},
    "参数": {'zh-CN': "参数", 'en-US': "Parameters", 'ja-JP': "パラメータ"},
    "输出": {'zh-CN': "输出", 'en-US': "Output", 'ja-JP': "出力"},
    "扒谱": {'zh-CN': "扒谱", 'en-US': "Audio-to-MIDI", 'ja-JP': "採譜"},
    "可以开始": {'zh-CN': "可以开始", 'en-US': "Ready to start", 'ja-JP': "開始できます"},
    "缺依赖": {'zh-CN': "缺依赖", 'en-US': "Missing dependencies", 'ja-JP': "依存関係が不足しています"},
    "读不到状态": {'zh-CN': "读不到状态", 'en-US': "Cannot read status", 'ja-JP': "状態を読み取れません"},
    "不支持续传": {'zh-CN': "不支持续传", 'en-US': "Resume is not supported", 'ja-JP': "再開には対応していません"},
    "进度": {'zh-CN': "进度", 'en-US': "Progress", 'ja-JP': "進捗"},
    "失败": {'zh-CN': "失败", 'en-US': "Failed", 'ja-JP': "失敗"},
    "许可与出处": {'zh-CN': "许可与出处", 'en-US': "Licenses and attribution", 'ja-JP': "ライセンスと帰属表示"},
    "素材": {'zh-CN': "素材", 'en-US': "Media", 'ja-JP': "素材"},
    "还没有选文件": {'zh-CN': "还没有选文件", 'en-US': "No file selected", 'ja-JP': "ファイルが選択されていません"},
    "正在读取媒体信息…": {
        'zh-CN': "正在读取媒体信息…",
        'en-US': "Reading media information…",
        'ja-JP': "メディア情報を読み込み中…"
    },
    "读不到这个文件": {
        'zh-CN': "读不到这个文件",
        'en-US': "Cannot read this file",
        'ja-JP': "このファイルを読み取れません"
    },
    "读不出媒体信息": {
        'zh-CN': "读不出媒体信息",
        'en-US': "Cannot read media information",
        'ja-JP': "メディア情報を取得できません"
    },
    "含视频轨": {'zh-CN': "含视频轨", 'en-US': "Contains video track", 'ja-JP': "動画トラックあり"},
    "容器": {'zh-CN': "容器", 'en-US': "Container", 'ja-JP': "コンテナ"},
    "大小": {'zh-CN': "大小", 'en-US': "Size", 'ja-JP': "サイズ"},
    "总码率": {'zh-CN': "总码率", 'en-US': "Total bitrate", 'ja-JP': "総ビットレート"},
    "音频编码": {'zh-CN': "音频编码", 'en-US': "Audio codec", 'ja-JP': "音声コーデック"},
    "采样率": {'zh-CN': "采样率", 'en-US': "Sample rate", 'ja-JP': "サンプルレート"},
    "声道": {'zh-CN': "声道", 'en-US': "Channels", 'ja-JP': "チャンネル"},
    "视频": {'zh-CN': "视频", 'en-US': "Video", 'ja-JP': "動画"},
    "处理操作": {'zh-CN': "处理操作", 'en-US': "Processing operation", 'ja-JP': "処理操作"},
    "格式列表为空": {'zh-CN': "格式列表为空", 'en-US': "Format list is empty", 'ja-JP': "形式一覧が空です"},
    "无损": {'zh-CN': "无损", 'en-US': "Lossless", 'ja-JP': "ロスレス"},
    "从 MV 里抽出音轨": {
        'zh-CN': "从 MV 里抽出音轨",
        'en-US': "Extract audio from MV",
        'ja-JP': "MVから音声トラックを抽出"
    },
    "变调半音数": {'zh-CN': "变调半音数", 'en-US': "Pitch shift (semitones)", 'ja-JP': "ピッチ変更（半音）"},
    "速度倍率": {'zh-CN': "速度倍率", 'en-US': "Speed ratio", 'ja-JP': "速度倍率"},
    "目标响度": {'zh-CN': "目标响度", 'en-US': "Target loudness", 'ja-JP': "目標ラウドネス"},
    "响度标准化": {'zh-CN': "响度标准化", 'en-US': "Loudness normalization", 'ja-JP': "ラウドネス正規化"},
    "处理失败": {'zh-CN': "处理失败", 'en-US': "Processing failed", 'ja-JP': "処理に失敗しました"},
    "不能覆盖输入文件": {
        'zh-CN': "不能覆盖输入文件",
        'en-US': "Cannot overwrite input file",
        'ja-JP': "入力ファイルを上書きできません"
    },
    "参数还不完整": {'zh-CN': "参数还不完整", 'en-US': "Parameters are incomplete", 'ja-JP': "パラメータが不完全です"},
    "搜索歌曲": {'zh-CN': "搜索歌曲", 'en-US': "Search songs", 'ja-JP': "曲を検索"},
    "搜到的歌会列在这里。": {
        'zh-CN': "搜到的歌会列在这里。",
        'en-US': "Search results will appear here.",
        'ja-JP': "検索結果がここに表示されます。"
    },
    "没有结果。换个关键词再试，或者直接把歌曲链接粘到下面。": {
        'zh-CN': "没有结果。换个关键词再试，或者直接把歌曲链接粘到下面。",
        'en-US': "No results. Try another keyword or paste a song URL below.",
        'ja-JP': "結果がありません。別のキーワードを試すか、下に曲のURLを貼り付けてください。"
    },
    "能下载": {'zh-CN': "能下载", 'en-US': "Available for download", 'ja-JP': "ダウンロード可能"},
    "不能下载": {'zh-CN': "不能下载", 'en-US': "Unavailable for download", 'ja-JP': "ダウンロード不可"},
    "粘贴链接": {'zh-CN': "粘贴链接", 'en-US': "Paste URL", 'ja-JP': "URLを貼り付け"},
    "正在读取本地歌词…": {
        'zh-CN': "正在读取本地歌词…",
        'en-US': "Reading local lyrics…",
        'ja-JP': "ローカル歌詞を読み込み中…"
    },
    "登录": {'zh-CN': "登录", 'en-US': "Log in", 'ja-JP': "ログイン"},
    "歌词预览": {'zh-CN': "歌词预览", 'en-US': "Lyrics preview", 'ja-JP': "歌詞プレビュー"},
    "预览方式": {'zh-CN': "预览方式", 'en-US': "Preview mode", 'ja-JP': "プレビューモード"},
    "还没有选中歌曲。": {
        'zh-CN': "还没有选中歌曲。",
        'en-US': "No song selected yet.",
        'ja-JP': "曲がまだ選択されていません。"
    },
    "保存": {'zh-CN': "保存", 'en-US': "Save", 'ja-JP': "保存"},
    "导出格式": {'zh-CN': "导出格式", 'en-US': "Export format", 'ja-JP': "エクスポート形式"},
    "双语": {'zh-CN': "双语", 'en-US': "Bilingual", 'ja-JP': "バイリンガル"},
    "双语导出": {'zh-CN': "双语导出", 'en-US': "Bilingual export", 'ja-JP': "バイリンガル出力"},
    "搜索资源": {'zh-CN': "搜索资源", 'en-US': "Search resources", 'ja-JP': "リソースを検索"},
    "清空搜索": {'zh-CN': "清空搜索", 'en-US': "Clear search", 'ja-JP': "検索をクリア"},
    "全部": {'zh-CN': "全部", 'en-US': "All", 'ja-JP': "すべて"},
    "说明": {'zh-CN': "说明", 'en-US': "Description", 'ja-JP': "説明"},
    "正在读取资源库…": {
        'zh-CN': "正在读取资源库…",
        'en-US': "Loading resource library…",
        'ja-JP': "リソースライブラリを読み込み中…"
    },
    "资源库读取失败": {
        'zh-CN': "资源库读取失败",
        'en-US': "Failed to load resource library",
        'ja-JP': "リソースライブラリの読み込みに失敗しました"
    },
    "资源库还是空的": {
        'zh-CN': "资源库还是空的",
        'en-US': "Resource library is still empty",
        'ja-JP': "リソースライブラリは空です"
    },
    "没有匹配的资源": {
        'zh-CN': "没有匹配的资源",
        'en-US': "No matching resources",
        'ja-JP': "一致するリソースがありません"
    },
    "粘贴 B 站链接 / BV 号 / 番剧 ep，或 YouTube 等站点链接": {
        "zh-CN": "粘贴 B 站链接 / BV 号 / 番剧 ep，或 YouTube 等站点链接",
        "en-US": "Paste a Bilibili URL / BV ID / episode ID, or a YouTube URL",
        "ja-JP": "BilibiliのURL / BV ID / エピソードID、またはYouTubeのURLを貼り付け"
    },
    "选中的编码兼容性差": {
        "zh-CN": "选中的编码兼容性差",
        "en-US": "The selected codec has poor compatibility",
        "ja-JP": "選択したコーデックは互換性が低いです"
    },
    "默认选最高画质并优先 H.264。": {
        "zh-CN": "默认选最高画质并优先 H.264。",
        "en-US": "Defaults to the highest quality and prefers H.264.",
        "ja-JP": "最高画質を選び、H.264を優先します。"
    },
    "默认 192K，兼容性最好": {
        "zh-CN": "默认 192K，兼容性最好",
        "en-US": "192K by default for best compatibility",
        "ja-JP": "既定は192Kで、互換性を優先"
    },
    "留空 = 用设置里的默认下载目录…": {
        "zh-CN": "留空 = 用设置里的默认下载目录…",
        "en-US": "Leave blank to use the default download directory…",
        "ja-JP": "空欄 = 設定の既定ダウンロード先を使用…"
    },
    "留空 = 直接放在输出目录": {
        "zh-CN": "留空 = 直接放在输出目录",
        "en-US": "Leave blank to save directly to the output directory",
        "ja-JP": "空欄 = 出力フォルダーに直接保存"
    },
    "下载在后台进行：切走视图不会中断。": {
        "zh-CN": "下载在后台进行：切走视图不会中断。",
        "en-US": "Downloads run in the background; switching views will not interrupt them.",
        "ja-JP": "ダウンロードはバックグラウンドで実行され、画面を切り替えても中断しません。"
    },
    "在右边试听每一轨，确认分得干净。": {
        "zh-CN": "在右边试听每一轨，确认分得干净。",
        "en-US": "Preview each stem on the right to check the separation.",
        "ja-JP": "右側で各ステムを試聴して、きれいに分離できているか確認します。"
    },
    "「下载」存到系统下载目录；也可点「打开输出目录」直接看。": {
        "zh-CN": "「下载」存到系统下载目录；也可点「打开输出目录」直接看。",
        "en-US": "Download saves to the system Downloads folder; you can also open the output folder.",
        "ja-JP": "「ダウンロード」はシステムのダウンロードフォルダーに保存します。「出力フォルダーを開く」も利用できます。"
    },
    "正在删除依赖文件…": {
        "zh-CN": "正在删除依赖文件…",
        "en-US": "Deleting dependency files…",
        "ja-JP": "依存ファイルを削除中…"
    },
    "检测到 NVIDIA 显卡：选 GPU（或自动）就走 CUDA，不需要加速包。": {
        "zh-CN": "检测到 NVIDIA 显卡：选 GPU（或自动）就走 CUDA，不需要加速包。",
        "en-US": "NVIDIA GPU detected: choose GPU (or Auto) to use CUDA; no acceleration package is needed.",
        "ja-JP": "NVIDIA GPUを検出しました。GPU（または自動）を選ぶとCUDAを使用するため、アクセラレーションパッケージは不要です。"
    },
    "不会被删": {"zh-CN": "不会被删", "en-US": "will not be deleted", "ja-JP": "削除されません"},
    "左边选好文件与模式，点「开始分离」。": {
        "zh-CN": "左边选好文件与模式，点「开始分离」。",
        "en-US": "Choose a file and mode on the left, then click “Start separation”.",
        "ja-JP": "左側でファイルとモードを選び、「分離開始」をクリックしてください。"
    },
    "B站炽阳001": {"zh-CN": "B站炽阳001", "en-US": "Bilibili Chiyang 001", "ja-JP": "Bilibili 炽阳001"},
    "选运行时的存放位置": {
        "zh-CN": "选运行时的存放位置",
        "en-US": "Choose runtime location",
        "ja-JP": "ランタイムの保存場所を選択"
    },
    "程序目录不可写，所以要另选一个位置。": {
        "zh-CN": "程序目录不可写，所以要另选一个位置。",
        "en-US": "The application directory is not writable, so choose another location.",
        "ja-JP": "アプリケーションフォルダーに書き込めないため、別の場所を選択してください。"
    },
    "D:\\歌\\干声.wav": {
        'zh-CN': 'D:\\歌\\干声.wav',
        'en-US': 'D:\\Song\\dry_vocal.wav',
        'ja-JP': 'D:\\歌\\ドライボーカル.wav'
    },
    "留空 = 音频同目录\\midi": {
        'zh-CN': '留空 = 音频同目录\\midi',
        'en-US': 'Leave blank = a midi folder beside the audio file',
        'ja-JP': '空欄 = 音声ファイルと同じ場所の\\midi'
    },
    "选 MIDI 写到哪个目录": {
        "zh-CN": "选 MIDI 写到哪个目录",
        "en-US": "Choose where to save MIDI files",
        "ja-JP": "MIDIの保存先フォルダーを選択"
    },
    " 10 秒换 1 秒音频": {
        "zh-CN": " 10 秒换 1 秒音频",
        "en-US": " 10 seconds per 1 second of audio",
        "ja-JP": " 1秒の音声に約10秒"
    },
    "未检测到 ffmpeg": {
        "zh-CN": "未检测到 ffmpeg",
        "en-US": "ffmpeg was not detected",
        "ja-JP": "ffmpegが見つかりません"
    },
    "未检测到": {"zh-CN": "未检测到", "en-US": "Not detected", "ja-JP": "未検出"},
    "tools 目录缺失，请重新解压程序包。": {
        "zh-CN": "tools 目录缺失，请重新解压程序包。",
        "en-US": "The tools directory is missing. Please extract the application package again.",
        "ja-JP": "toolsフォルダーがありません。アプリケーションパッケージを再展開してください。"
    },
    "音频 / 视频文件的完整路径，例如 H:\\音乐\\Never Gonna Give You Up.mp4": {
        'zh-CN': '音频 / 视频文件的完整路径，例如 H:\\音乐\\Never Gonna Give You Up.mp4',
        'en-US': 'Full audio/video path, e.g. H:\\Music\\Never Gonna Give You Up.mp4',
        'ja-JP': '音声/動画ファイルの完全なパス（例：H:\\音楽\\Never Gonna Give You Up.mp4）'
    },
    "没能读出媒体信息": {
        "zh-CN": "没能读出媒体信息",
        "en-US": "Could not read media information",
        "ja-JP": "メディア情報を読み取れませんでした"
    },
    "留空 = 写到系统下载目录…": {
        "zh-CN": "留空 = 写到系统下载目录…",
        "en-US": "Leave blank to use the system Downloads folder…",
        "ja-JP": "空欄 = システムのダウンロードフォルダーに保存…"
    },
    "自动按操作推断，例如 xxx_+3半音.wav": {
        "zh-CN": "自动按操作推断，例如 xxx_+3半音.wav",
        "en-US": "Infer automatically from the operation, e.g. xxx_+3semitones.wav",
        "ja-JP": "操作内容から自動判定（例：xxx_+3半音.wav）"
    },
    "将写入：": {"zh-CN": "将写入：", "en-US": "Will write to:", "ja-JP": "書き込み先："},
    "歌名 / 歌手，回车搜索（例如：千本桜）": {
        "zh-CN": "歌名 / 歌手，回车搜索（例如：千本桜）",
        "en-US": "Song title / artist, press Enter to search (e.g. Senbonzakura)",
        "ja-JP": "曲名 / アーティスト、Enterで検索（例：千本桜）"
    },
    "粘贴歌曲链接，例如 https://music.163.com/#/song?id=186016": {
        "zh-CN": "粘贴歌曲链接，例如 https://music.163.com/#/song?id=186016",
        "en-US": "Paste a song URL, e.g. a NetEase Music URL",
        "ja-JP": "曲のURLを貼り付け（例：NetEase MusicのURL）"
    },
    "11 位手机号，不用填 +86": {
        "zh-CN": "11 位手机号，不用填 +86",
        "en-US": "11-digit phone number; do not include +86",
        "ja-JP": "11桁の電話番号（+86は不要）"
    },
    "手机收到的短信验证码": {
        "zh-CN": "手机收到的短信验证码",
        "en-US": "SMS verification code",
        "ja-JP": "SMS認証コード"
    },
    "MUSIC_U=...　（怎么拿见下面的步骤说明）": {
        "zh-CN": "MUSIC_U=...　（怎么拿见下面的步骤说明）",
        "en-US": "MUSIC_U=... (see the steps below for how to get it)",
        "ja-JP": "MUSIC_U=...（取得方法は下の手順を参照）"
    },
    "⚠ 等同于账号登录态，别分享、别截图": {
        "zh-CN": "⚠ 等同于账号登录态，别分享、别截图",
        "en-US": "⚠ This is equivalent to your account session; do not share or screenshot it.",
        "ja-JP": "⚠ アカウントのログイン状態と同等です。共有・スクリーンショットは禁止です。"
    },
    "怎么拿到 Cookie？（点开看步骤）": {
        "zh-CN": "怎么拿到 Cookie？（点开看步骤）",
        "en-US": "How do I get the Cookie? (click for steps)",
        "ja-JP": "Cookieの取得方法（クリックして手順を表示）"
    },
    " → 点 ": {"zh-CN": " → 点 ", "en-US": " → click ", "ja-JP": " → クリック "},
    "回到这里粘进上面的框，点「保存」。": {
        "zh-CN": "回到这里粘进上面的框，点「保存」。",
        "en-US": "Paste it into the box above and click “Save”.",
        "ja-JP": "ここに戻って上の欄へ貼り付け、「保存」をクリックします。"
    },
    "歌词保存目录…": {"zh-CN": "歌词保存目录…", "en-US": "Lyrics save directory…", "ja-JP": "歌詞の保存先…"},
    "文件名（默认：歌名 - 歌手）": {
        "zh-CN": "文件名（默认：歌名 - 歌手）",
        "en-US": "Filename (default: song title - artist)",
        "ja-JP": "ファイル名（既定：曲名 - アーティスト）"
    },
    "JIZURA 文字 PV 编辑器": {
        "zh-CN": "JIZURA 文字 PV 编辑器",
        "en-US": "JIZURA Lyric PV Editor",
        "ja-JP": "JIZURA 歌詞PVエディター"
    },
    "搜索名称、描述、标签…": {
        "zh-CN": "搜索名称、描述、标签…",
        "en-US": "Search names, descriptions, tags…",
        "ja-JP": "名前、説明、タグを検索…"
    },
    "手动复制链接": {"zh-CN": "手动复制链接", "en-US": "Copy link manually", "ja-JP": "リンクを手動でコピー"},
    "来自官方 / 原作者渠道": {
        "zh-CN": "来自官方 / 原作者渠道",
        "en-US": "Official / original author source",
        "ja-JP": "公式 / 原作者の配布元"
    },
    "社区或第三方渠道，自己判断可靠性": {
        "zh-CN": "社区或第三方渠道，自己判断可靠性",
        "en-US": "Community or third-party source; verify reliability yourself",
        "ja-JP": "コミュニティまたは第三者の配布元です。信頼性を自分で確認してください"
    },
    /* ── 平台能力（`platform.rs::caps`）：macOS 上做不到的那几件 ──
       ⚠️ 头三条与「分离请用…」那两条里的原因**来自后端**（Rust 里的中文原句），
       键就是那句话本身 —— 改后端文案就要回来改这里。 */
    "离线分离的运行时包是 Windows 专属（python.exe + DirectML）": {
        "zh-CN": "离线分离的运行时包是 Windows 专属（python.exe + DirectML）",
        "en-US": "The offline separation runtime is Windows-only (python.exe + DirectML)",
        "ja-JP": "オフライン分離のランタイムはWindows専用です（python.exe + DirectML）"
    },
    "Wallpaper Engine 只有 Windows 版，Steam 库里读不到它": {
        "zh-CN": "Wallpaper Engine 只有 Windows 版，Steam 库里读不到它",
        "en-US": "Wallpaper Engine is Windows-only, so it is not in this Steam library",
        "ja-JP": "Wallpaper EngineはWindows版のみのため、このSteamライブラリにはありません"
    },
    "macOS 上没有 CUDA，显卡推理用不了；CPU 推理正常": {
        "zh-CN": "macOS 上没有 CUDA，显卡推理用不了；CPU 推理正常",
        "en-US": "There is no CUDA on macOS, so GPU inference is unavailable; CPU inference works",
        "ja-JP": "macOSにはCUDAがないためGPU推論は使えません。CPU推論は正常に動作します"
    },
    "这个平台没有它的运行时包": {
        "zh-CN": "这个平台没有它的运行时包",
        "en-US": "No runtime package for this platform",
        "ja-JP": "このプラットフォーム用のランタイムパッケージはありません"
    },
    "本平台用不了离线分离": {
        "zh-CN": "本平台用不了离线分离",
        "en-US": "Offline separation is unavailable here",
        "ja-JP": "このプラットフォームではオフライン分離を使えません"
    },
    "这个平台没有离线引擎": {
        "zh-CN": "这个平台没有离线引擎",
        "en-US": "This platform has no offline engine",
        "ja-JP": "このプラットフォームにはオフラインエンジンがありません"
    },
    "这个平台没有离线分离的运行时包": {
        "zh-CN": "这个平台没有离线分离的运行时包",
        "en-US": "This platform has no runtime package for offline separation",
        "ja-JP": "このプラットフォームにはオフライン分離のランタイムパッケージがありません"
    },
    "分离请用右栏的「在线分离：MVSEP」—— 那条路与本平台无关。": {
        "zh-CN": "分离请用右栏的「在线分离：MVSEP」—— 那条路与本平台无关。",
        "en-US": "Use “Online separation: MVSEP” on the right instead — that route does not depend on the platform.",
        "ja-JP": "右側の「オンライン分離：MVSEP」をお使いください。こちらはプラットフォームに依存しません。"
    },
    "下面的「在线分离：MVSEP」照常用。": {
        "zh-CN": "下面的「在线分离：MVSEP」照常用。",
        "en-US": "“Online separation: MVSEP” below still works as usual.",
        "ja-JP": "下の「オンライン分離：MVSEP」はそのまま使えます。"
    },
    "这个平台用不了 Wallpaper Engine 壁纸": {
        "zh-CN": "这个平台用不了 Wallpaper Engine 壁纸",
        "en-US": "Wallpaper Engine wallpapers are unavailable on this platform",
        "ja-JP": "このプラットフォームではWallpaper Engineの壁紙を使えません"
    },
    "Wallpaper Engine 只有 Windows 版": {
        "zh-CN": "Wallpaper Engine 只有 Windows 版",
        "en-US": "Wallpaper Engine is Windows-only",
        "ja-JP": "Wallpaper EngineはWindows版のみです"
    },
    "背景只能用自带的静态图；玻璃材质、主题、配色都不受影响。": {
        "zh-CN": "背景只能用自带的静态图；玻璃材质、主题、配色都不受影响。",
        "en-US": "Only the built-in static images can be used as the background; glass, theme and colours are unaffected.",
        "ja-JP": "背景には付属の静止画像のみを使用できます。ガラス表現・テーマ・配色には影響しません。"
    },
    "配置在程序目录": {
        "zh-CN": "配置在程序目录",
        "en-US": "Config lives beside the app",
        "ja-JP": "設定はアプリと同じフォルダー"
    },
    "配置在 %APPDATA%": {
        "zh-CN": "配置在 %APPDATA%",
        "en-US": "Config lives in %APPDATA%",
        "ja-JP": "設定は %APPDATA%"
    },
    "配置在 ~/Library/Application Support": {
        "zh-CN": "配置在 ~/Library/Application Support",
        "en-US": "Config lives in ~/Library/Application Support",
        "ja-JP": "設定は ~/Library/Application Support"
    },
    "减速": {"zh-CN": "减速", "en-US": "Slower", "ja-JP": "遅く"},
    "原速": {"zh-CN": "原速", "en-US": "Original speed", "ja-JP": "元の速さ"},
    /* ── 更新提醒（`update.rs` 的回包 + 启动时那次静默检查） ── */
    "有新版本": {"zh-CN": "有新版本", "en-US": "New version available", "ja-JP": "新しいバージョンがあります"},
    "打开发布页": {"zh-CN": "打开发布页", "en-US": "Open release page", "ja-JP": "リリースページを開く"},
    "打开发布页失败": {
        "zh-CN": "打开发布页失败",
        "en-US": "Could not open the release page",
        "ja-JP": "リリースページを開けませんでした"
    },
    "稍后再说": {"zh-CN": "稍后再说", "en-US": "Later", "ja-JP": "あとで"},
    "发布于": {"zh-CN": "发布于", "en-US": "Published", "ja-JP": "公開"},
    "（预览版）": {"zh-CN": "（预览版）", "en-US": " (pre-release)", "ja-JP": "（プレリリース）"},
    "这条发布没有写说明。": {
        "zh-CN": "这条发布没有写说明。",
        "en-US": "This release has no notes.",
        "ja-JP": "このリリースには説明がありません。"
    },
    "未知日期": {"zh-CN": "未知日期", "en-US": "unknown date", "ja-JP": "日付不明"},
    "已经是最新版本": {
        "zh-CN": "已经是最新版本",
        "en-US": "You are on the latest version",
        "ja-JP": "最新バージョンです"
    },
    "上游最新发布": {"zh-CN": "上游最新发布", "en-US": "latest upstream release", "ja-JP": "上流の最新リリース"},
    "检查更新": {"zh-CN": "检查更新", "en-US": "Check for updates", "ja-JP": "更新を確認"},
    "从 GitHub 的 Release 页查一次最新发布": {
        "zh-CN": "从 GitHub 的 Release 页查一次最新发布",
        "en-US": "Ask the GitHub release page for the latest version",
        "ja-JP": "GitHubのリリースページに最新版を問い合わせます"
    },
    "GitHub 直连不通，这次是经镜像代查的": {
        "zh-CN": "GitHub 直连不通，这次是经镜像代查的",
        "en-US": "GitHub is unreachable, so this check went through a mirror",
        "ja-JP": "GitHubに直に接続できないため、ミラー経由で照会しました"
    },
    "加速": {"zh-CN": "加速", "en-US": "Faster", "ja-JP": "速く"},
    "解析 MV 链接": {"zh-CN": "解析 MV 链接", "en-US": "Parse MV link", "ja-JP": "MVリンクを解析"},
    "打开资源库": {"zh-CN": "打开资源库", "en-US": "Open resources", "ja-JP": "リソースを開く"},
    "默认位置": {"zh-CN": "默认位置", "en-US": "Default location", "ja-JP": "既定の場所"},
    "已自定义": {"zh-CN": "已自定义", "en-US": "Customised", "ja-JP": "カスタム済み"},
    "确认新位置能用之后再手动清掉它": {
        "zh-CN": "确认新位置能用之后再手动清掉它",
        "en-US": "Delete the old one by hand once the new location works",
        "ja-JP": "新しい場所で動作を確認してから、古い方を手動で削除してください"
    },
    "这个目录里已经有一份音轨分离运行时。": {
        "zh-CN": "这个目录里已经有一份音轨分离运行时。",
        "en-US": "This directory already holds a stem-separation runtime.",
        "ja-JP": "このフォルダーには既にステム分離のランタイムがあります。"
    },
}

export function getUiLanguage(): UiLanguage {
    const value = getConfig().language
    return value === 'en-US' || value === 'ja-JP' ? value : 'zh-CN'
}

export function setUiLanguage(language: UiLanguage) {
    saveConfig({language})
}

export function translate(text: string, language = getUiLanguage()): string {
    return DICT[text]?.[language] ?? text
}

/* ⚠️ 订阅函数**必须把退订函数还回去** —— `useSyncExternalStore` 靠它做清理，
   而 `useI18n` 每个页面都在用，只加不退会让 `listeners` 随切页一直涨。 */
const subscribe = (cb: () => void) => onConfigChange(cb)
const getSnapshot = () => getUiLanguage()

export function useI18n() {
    const language = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    const t = (text: string) => translate(text, language)
    return {language, t, setLanguage: setUiLanguage}
}
