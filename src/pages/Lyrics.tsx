import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react'
import {SegmentedControl, Switch} from '@/components/ui'
import {api} from '@/lib/api'
import {getConfig, onConfigChange, saveConfig, syncConfig} from '@/lib/config'
import {baseName, errText} from '@/lib/format'
import {Button} from '@/components/Button'
import {Credit, Upstream} from '@/components/Credit'
import {DirectoryInput} from '@/components/DirPicker'
import {DropHint, useFilePick} from '@/components/FilePick'
import {Field, TextArea, TextInput} from '@/components/Field'
import {Icon} from '@/components/Icon'
import {Chip, Panel, PanelHead} from '@/components/Panel'
import type {PageProps, ToastTone} from './types'
import './Lyrics.css'
import {useI18n} from '@/lib/i18n'

/**
 * 歌词（网易云专区）：搜歌 → 取歌词 → 导出 LRC / SRT → 下载封面 / 歌曲 → 带去「文字 PV」。
 *
 * 三条路取词，之后共用同一套预览 / 保存 / 下封面 / 下歌曲 / 带去 PV：
 *
 *   1. 搜索（`lyricsSearch` → 点一条 → `lyricsGet`）
 *   2. 粘贴链接（`lyricsParseLink`，只认网易云链接 / 歌曲 ID）
 *   3. 本地 `.lrc` 导入（`lyricsImport`，返回和 `lyricsGet` 同一个形状，另有 `encoding`）
 *
 * 这一页**只有网易云**：没有 QQ 音乐来源、没有 QQ Cookie 输入框、没有 songmid 解析，
 * 后端也没有那套实现。`source` 只剩 'netease'。
 *
 * ⚠️ **扫码登录已移除，别再写**：网易云始终回 `8821 请切换其他登录方式`，
 * 判断是服务端风控（`AGENTS.md` 第十节）。留了手机号验证码 + Cookie 两条路。
 * ⚠️ **测试时绝不要调 `lyricsSms`**（会真的发短信）。
 *
 * 登录态就是 config 里的 `neteaseCookie` 一个字段，
 * 后端只回显脱敏占位「已设置」—— 所以界面上永远不回显真实值。
 */

/** 后端对已保存的 Cookie 只回显这个占位串（真实值不出后端） */
const MASK = '已设置'

/** 导入文件时后端读到的编码 → 界面上给用户看的说法 */
const ENC_LABEL: Record<string, string> = {
    'utf-8': 'UTF-8',
    gbk: 'GBK',
    unknown: '编码没认出来',
}

const MODES = [
    {value: 'both', label: '对照'},
    {value: 'orig', label: '只看原文'},
    {value: 'trans', label: '只看译文'},
]

/**
 * 网易云 `fee` 的说法。**它不等于「能不能下载」**（同为 `fee=0` 的歌，
 * 有的拿得到直链、有的拿不到），所以界面上只把这个当标签，能不能下的判据是
 * 下载接口的返回。下载失败时的文案由后端给（已写明版权 / 会员 / 要登录）。
 */
const feeLabel = (fee?: number): string => {
    if (fee === 1) return 'VIP'
    if (fee === 4) return '付费专辑'
    if (fee === 8) return '低音质免费'
    return ''
}

/**
 * 本页自己攒的「这首歌」形状（**后端真实回包见 `lib/api.ts` 的 `LyricsDoc` / `LyricsHit`**）。
 *
 * 三条取词路最后都并成这一个形状：搜索结果（有 `id`）、接口取词（`id` 在外层，`song` 里没有）、
 * 本地导入（`id` 是完整路径）。留一份本地声明是因为要的是「界面自己拼出来的」类型，
 * 而 `api.ts` 那两个类型文件私有（只服务于它自己的方法签名）。
 *
 * ⚠️ 调用点**已经不需要 `as unknown as` 断言了**：`api.ts` 的回包类型与后端源码一致
 * （`lyrics.rs` 的 `fetch` / `import_file`），直接用返回值即可。
 * 要改形状就改 `api.ts`，别照着这里的类型去改后端。
 */
interface LyricSong {
    /** 只在搜索结果里有；取词响应里的 `song` 不带 id */
    id?: string | number
    name?: string
    artists?: string
    album?: string
    cover?: string
    durationSec?: number
    /** 网易云的收费标记（0 免费 / 1 VIP / 4 付费专辑 / 8 低音质免费）—— 只当标签，不当能不能下的判据 */
    fee?: number
    /**
     * 这个版本能不能拿到直链 —— 后端在搜索后**批量**探测出来的（`true` 能下 / `false` 不能下）。
     * 从搜索进 `loadLyric` 时原样带进 `current`；粘贴链接或导入进来的没有这个字段（`undefined`）。
     * ⚠️ 别用 `fee` 代替它：同为 `fee=0` 的歌两种结果都有。
     */
    playable?: boolean
}

interface LyricFile {
    source?: string
    id?: string | number
    song?: LyricSong
    lyric?: string
    trans?: string
    encoding?: string
}

/** 当前这首歌 —— 三条取词路最后都落成这一个形状 */
interface Current extends LyricFile {
    id: string | number
    source: string
    /** 只从搜索结果带过来（见 `loadLyric`）：能不能下的标记 */
    playable?: boolean
}

/** 归一化成一个字符串 id（网易云是数字，QQ 是 songmid，导入是完整路径） */
const asId = (id: string | number | undefined): string => (id === undefined || id === null ? '' : String(id))

/* ══════════════════════════════════════════════════════════ 歌词文本工具 ══ */

/**
 * 解析 LRC 成 `[{ ms, text }]`（只用来在界面上对齐显示，落盘由后端负责）。
 * 支持 `[mm:ss]` / `[mm:ss.SS]` / `[mm:ss:SS]` 以及一行多个时间戳。
 */
function parseLrc(text: string | null | undefined): { ms: number; text: string }[] {
    const out: { ms: number; text: string }[] = []
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        const re = /\[(\d+):(\d+(?:[.:]\d+)?)]/g
        const times: number[] = []
        let m: RegExpExecArray | null
        let end = 0
        while ((m = re.exec(line))) {
            times.push(toMs(m[1], m[2]))
            end = re.lastIndex
        }
        const content = line.slice(end).trim()
        if (!times.length || !content) continue
        for (const ms of times) out.push({ms, text: content})
    }
    return out.sort((a, b) => a.ms - b.ms)
}

/** `"02:345"` / `"02.34"` → 毫秒，毫秒位数按 1 位 ×100、2 位 ×10、3 位原样 */
function toMs(min: string, sec: string): number {
    const [s, frac = ''] = String(sec).split(/[.:]/)
    const digits = frac.slice(0, 3)
    const ms =
        digits.length === 1 ? Number(digits) * 100 : digits.length === 2 ? Number(digits) * 10 : Number(digits || 0)
    return (Number(min) * 60 + Number(s)) * 1000 + ms
}

/** 毫秒 → `mm:ss.xx`（预览用） */
function mmss(ms: number): string {
    const m = Math.floor(ms / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`
}

/** 译文按时间戳对齐：先精确匹配，再容忍 ±50ms（和后端同一条规则） */
function alignTrans(text: string | null | undefined): (ms: number) => string {
    const list = parseLrc(text)
    const exact = new Map<number, string>()
    for (const l of list) if (!exact.has(l.ms)) exact.set(l.ms, l.text)
    return (ms) => {
        const hit = exact.get(ms)
        if (hit !== undefined) return hit
        const near = list.find((l) => Math.abs(l.ms - ms) <= 50)
        return near ? near.text : ''
    }
}

const fmtDuration = (sec?: number): string =>
    sec ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : ''

/**
 * 配置里跟登录态有关的那几项。
 *
 * ⚠️ **必须订阅配置存储，不能只读 `state.config`**：手机号登录 / 退出登录 / 续期这三条
 * 命令是**后端**自己写 `config.json` 的，前端内存那份要等下一次 `get_state` 才对得上，
 * 而歌词页的登录徽章与「退出登录」按钮都按它显示 —— 不订阅就会出现「刚登录成功，
 * 界面还写着未登录」。`state` 那份仍是启动时的快照，只当兜底。
 */
function useNeteaseAuth() {
    const cfg = useSyncExternalStore(onConfigChange, getConfig, getConfig)
    return {cookie: String(cfg.neteaseCookie ?? ''), expireAt: Number(cfg.neteaseCookieExpire ?? 0)}
}

/* ══════════════════════════════════════════════════════════════════ 视图 ══ */

export function Lyrics({state, onNavigate, onRefreshState, onToast}: PageProps) {
    const {t} = useI18n()
    const config = state?.config ?? {}

    const [keyword, setKeyword] = useState('')
    const [hits, setHits] = useState<LyricSong[] | null>(null)
    const [searching, setSearching] = useState(false)
    const [searchErr, setSearchErr] = useState<string | null>(null)

    const [url, setUrl] = useState('')
    const [pasteLoading, setPasteLoading] = useState(false)
    const [importing, setImporting] = useState(false)

    const [doc, setDoc] = useState<LyricFile | null>(null)
    const [current, setCurrent] = useState<Current | null>(null)
    const [previewErr, setPreviewErr] = useState<string | null>(null)

    const [mode, setMode] = useState('both')
    const [format, setFormat] = useState('lrc')
    /**
     * 下载档位上限：`auto` / `hires` / `lossless` / `exhigh` / `higher` / `standard`。
     *
     * ⚠️ 它是**上限不是承诺** —— 服务端会静默降级（求无损只给 320 kbps），所以界面上一律
     * 显示回包给的**实际**档位，不显示这里选的值。
     */
    const [quality, setQuality] = useState('auto')
    const [bilingual, setBilingual] = useState(true)

    const [outDir, setOutDir] = useState('')
    const [name, setName] = useState('')
    const [saving, setSaving] = useState(false)
    const [coverLoading, setCoverLoading] = useState(false)
    const [songLoading, setSongLoading] = useState(false)
    const [saved, setSaved] = useState('')

    const [phone, setPhone] = useState('')
    const [captcha, setCaptcha] = useState('')
    const [smsLeft, setSmsLeft] = useState(0)
    const [loginMsg, setLoginMsg] = useState('')
    const [loginTone, setLoginTone] = useState<ToastTone>('warn')
    const [busy, setBusy] = useState(false)
    const [nickname, setNickname] = useState('')
    /** 会员标签（「黑胶SVIP·肆」）跟着 `lyricsAccount` 走；有效期读配置存储 */
    const [vip, setVip] = useState('')
    /**
     * 服务端明确说凭据失效了（`lyricsAccount` 的 `expired`）—— 界面据此置为未登录。
     *
     * ⚠️ **只改界面，不动已存的 Cookie**：风控误判时清掉，用户就得重新贴一遍。
     * 网络不通（`offline`）绝不进这个状态。
     */
    const [authExpired, setAuthExpired] = useState(false)
    const [renewing, setRenewing] = useState(false)
    const [neteaseCookie, setNeteaseCookie] = useState('')
    const {cookie: storedCookie, expireAt} = useNeteaseAuth()

    /**
     * `edited` —— 用户手动改过输出目录之后，设置页里的默认值不再盖掉它。
     * `init` —— 默认目录**只为首次拿到 state 时填一次**（state 刷新不该覆盖用户的选择）。
     */
    const flags = useRef({edited: false, init: false})
    const timer = useRef<number | null>(null)
    /** 取词请求的序列号：只有最新一次的结果能落地（见 `loadLyric`） */
    const loadSeq = useRef(0)
    /** 上一次自动填进「文件名」的那个名字，用来区分「用户改过」与「我们填的」 */
    const autoName = useRef('')

    useEffect(() => {
        if (flags.current.init || !state) return
        flags.current.init = true
        setOutDir(state.paths?.outputDir ?? String(config.outputDir ?? ''))
        // config 只在首帧读一次，故意不进依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state])

    /* 短信倒计时：既是防连点，也是免得用户一直点着发短信。离开页面时定时器要停掉 */
    useEffect(() => {
        if (smsLeft <= 0) return
        const id = window.setTimeout(() => setSmsLeft((n) => n - 1), 1000)
        return () => window.clearTimeout(id)
    }, [smsLeft])
    useEffect(() => {
        if (timer.current) window.clearTimeout(timer.current)
        return () => {
            if (timer.current) window.clearTimeout(timer.current)
        }
    }, [])

    /* 登录态校验 + 临近过期自动续期。挂在挂载时跑一次就够 —— 之后每次登录 / 保存 Cookie /
       续期都由那几条命令自己刷，反复打接口没有意义，而「登录态有没有过期」一天变一次。 */
    useEffect(() => {
        if (!storedCookie) return
        void refreshAccount({renew: true})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** 一条提示只改内容：错误留在页面上，别只弹个 toast 就没了 */
    const setMsg = (text: string, tone: ToastTone = 'warn') => {
        setLoginMsg(text)
        setLoginTone(tone)
    }

    /* ── 搜索 ───────────────────────────────────────────────── */

    const doSearch = async () => {
        const kw = keyword.trim()
        if (!kw) {
            onToast('请先输入歌名或歌手', 'warn')
            return
        }
        setSearching(true)
        setSearchErr(null)
        try {
            const res = await api.lyricsSearch({source: 'netease', keyword: kw})
            const list = res.songs ?? []
            setHits(list)
            if (!list.length) onToast('没有搜到结果', 'warn')
        } catch (e) {
            // 失败要留在结果区里，不能只闪一个 toast
            setHits(null)
            setSearchErr(errText(e))
            onToast(errText(e), 'err')
        } finally {
            setSearching(false)
        }
    }

    /* ── 取词：搜到的歌 / 粘贴的链接都走这里 ─────────────────── */

    /**
     * 取词。`playable` 是搜索结果那条上的「能不能下」标记，**原样带进 `current`** ——
     * 后端取词接口不探测可下载性，只有搜索结果探测过（见 `downloadSong` 的重试用它挑版本）。
     *
     * ⚠️ **只认最后一次请求**（`loadSeq`）：搜索结果是一条条点的，点快了就有两次请求同时在
     * 飞，而它们回来的顺序不保证与点单顺序一致 —— 不设防的话「选中的是 B，预览里是 A」。
     * 三条取词路（搜索 / 链接 / 本地文件）都从这里过一遍同一个序列号，所以互相也抢不了。
     */
    const loadLyric = async (id: string | number, playable?: boolean) => {
        const seq = ++loadSeq.current
        setPreviewErr(null)
        try {
            const res = await api.lyricsGet({source: 'netease', id})
            if (seq !== loadSeq.current) return
            setDoc(res)
            setCurrent({...res, id, source: 'netease', playable})
            /* 文件名跟着歌名走，但**用户自己改过就别动**（按「上一次自动填的那个」判，
               而不是「非空就不动」—— 后者会让第二首歌的下载文件名还是第一首的） */
            const suggested = [res.song?.name, res.song?.artists].filter(Boolean).join(' - ')
            setName((prev) => (prev.trim() && prev !== autoName.current ? prev : suggested))
            autoName.current = suggested
            if (!String(res.trans ?? '').trim()) onToast('这首歌没有翻译歌词，只能导出原文', 'info')
        } catch (e) {
            if (seq !== loadSeq.current) return
            setPreviewErr(errText(e))
            onToast(errText(e), 'err')
        }
    }

    /* ── 粘贴链接直接解析 ───────────────────────────────────── */

    const doParseLink = async () => {
        const u = url.trim()
        if (!u) {
            onToast('请先粘贴歌曲链接', 'warn')
            return
        }
        setPasteLoading(true)
        try {
            // url 原样传：只认网易云链接 / 歌曲 ID，认不出来后端会明确报错（前端不猜）
            const res = await api.lyricsParseLink({url: u})
            // 解析出来直接拉歌词（粘贴链接的场景不用再点一次）
            await loadLyric(res.id)
            onToast(`已识别为网易云：${res.id}`, 'ok')
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setPasteLoading(false)
        }
    }

    /* ── 本地 .lrc 导入 ─────────────────────────────────────── */

    const importPath = async (path: string) => {
        setImporting(true)
        setPreviewErr(null)
        // 本地导入也算一次新的取词：把还在飞的搜索取词作废（见 `loadLyric`）
        loadSeq.current += 1
        try {
            const res = await api.lyricsImport({path})
            const id = res.id ?? path
            setDoc(res)
            setCurrent({...res, id, source: res.source ?? 'file'})
            const suggested = [res.song?.name, res.song?.artists].filter(Boolean).join(' - ')
            setName((prev) => (prev.trim() && prev !== autoName.current ? prev : suggested))
            autoName.current = suggested
            if (res.encoding === 'unknown') {
                onToast('这个文件既不是 UTF-8 也不是 GBK，显示出来可能是乱码', 'warn')
            } else {
                onToast(res.encoding === 'gbk' ? '已按 GBK 读取本地歌词' : '已导入本地歌词', 'ok')
            }
        } catch (e) {
            setPreviewErr(errText(e))
            onToast(errText(e), 'err')
        } finally {
            setImporting(false)
        }
    }

    /**
     * 选本地 .lrc：**系统「打开」对话框**（`pick_paths`）或把文件直接拖进这一页
     * （拖进来的东西由 Tauri 给**真路径**，见 `components/FilePick.tsx`）。
     *
     * ⚠️ **选文件和选目录是两件事，这里别挂 `DirectoryInput`** —— 那是**目录**选择器，
     * 拿它选文件会逼用户先在目录树里逛到文件夹、再手打文件名。
     */
    const {
        pick: pickLrc,
        dropProps,
        dragging,
        busy: droppingLrc,
    } = useFilePick({
        exts: ['lrc'],
        label: '歌词文件',
        title: '选一个 .lrc 文件',
        onPaths: (paths) => void importPath(paths[0]),
        onToast,
    })

    /* ── 保存 / 封面 ────────────────────────────────────────── */

    const saveLyric = async () => {
        if (!current) {
            onToast('请先选中一首歌并取到歌词', 'warn')
            return
        }
        setSaving(true)
        try {
            const res = (await api.lyricsSave({
                source: current.source,
                id: current.id,
                lyric: current.lyric,
                trans: current.trans,
                durationSec: current.song?.durationSec ?? 0,
                format,
                bilingual,
                outDir,
                name: name.trim(),
            }))
            onToast(`已保存 ${res.name ?? baseName(res.path)}`, 'ok')
            setSaved(res.path)
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setSaving(false)
        }
    }

    const downloadCover = async () => {
        const cover = current?.song?.cover
        if (!cover) {
            onToast('这首歌没有封面，或还没选中歌曲', 'warn')
            return
        }
        setCoverLoading(true)
        try {
            const res = (await api.lyricsCover({
                url: cover,
                outDir,
                name: name.trim() || current?.song?.name || 'cover',
            }))
            onToast(`封面已保存 ${baseName(res.path)}`, 'ok')
            setSaved(res.path)
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setCoverLoading(false)
        }
    }

    /**
     * 下载歌曲（网易云直链 → 存成 mp3，接口说是别的格式就按真实格式存）。
     *
     * ⚠️ 拿不到直链时后端回 400，文案已经是给用户看的（版权受限 / 只有会员能听 / 要登录），
     * **原样弹出来**，不要再包一层「下载失败」——那会把真正的原因盖掉。
     * 只有「本地文件」这种没有网易云 id 的来源才在这里先拦一下。
     *
     * **这首歌下不了就自动换一个能下的版本**：
     * 同名歌在搜索结果里往往有十几个版本，能下的只有一两个，而**哪个能下与 `fee` 无关**，
     * 只有后端批量探测出来的 `playable` 说得准。所以失败时从 `hits` 里挑第一条
     * `playable === true` 且没试过的版本，取词 + 重下一次；歌词、译文、封面跟着换成新版本的。
     */
    const downloadSong = async () => {
        if (current?.source === 'file') {
            onToast('这是本地导入的歌词，没有对应的网易云歌曲可以下载', 'warn')
            return
        }
        if (!current) {
            onToast('请先搜索或粘贴链接选中一首歌', 'warn')
            return
        }
        const tried = new Set<string>([asId(current.id)])
        setSongLoading(true)
        try {
            let res
            try {
                res = await api.lyricsSong({
                    id: current.id,
                    outDir,
                    name: name.trim() || current.song?.name || '',
                    quality,
                    // 曲目时长用来拦「只拿到 30 秒试听片段」；拿不到就不传，后端此时不判
                    durationSec: current.song?.durationSec,
                })
            } catch (e) {
                // 换版本只在「已经知道别的版本能下」时才做，不然会把真正的错误盖成一次空转
                const alt = (hits ?? []).find((h) => h.playable === true && !tried.has(asId(h.id)))
                if (!alt) throw e
                onToast(`${errText(e)}正在换成另一个版本重试…`, 'warn')
                tried.add(asId(alt.id))
                await loadLyric(alt.id!, true)
                res = await api.lyricsSong({
                    id: alt.id!,
                    outDir,
                    name: name.trim() || alt.name || '',
                    quality,
                    durationSec: alt.durationSec,
                })
            }
            // level 是「极高 / 320 kbps」这种给人看的说法，直接跟上。
            // ⚠️ 服务端会静默降级（求无损只回 320 kbps 且 url 照样给），降级过就明说 ——
            // 否则用户会以为存下来的是无损
            onToast(
                `歌曲已保存 ${res.name}（${res.level}）` +
                (res.downgraded ? '。服务端没有给到该档位，上面是它实际给到的最高档' : ''),
                'ok',
            )
            setSaved(res.path)
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setSongLoading(false)
        }
    }

    /* ── 一键带去「文字 PV」─────────────────────────────────────
       交接方式：写进**配置**（`config.json` 的 `pvPendingLyrics`，文字 PV 页读它），
       再导航过去。不用 params 传：params 只在这次导航里存在，在 PV 页按一下 F5 就没了。
       ⚠️ **不能用浏览器存储** —— 它按 origin 隔离，窗口加载方式再变一次这条交接就会
       **静默**断掉（读到空串）。
       带的是**原文 LRC 原文**，不自己拼双语 —— JIZURA 认 LRC 时间戳，也认
       `歌词|注音` 这种一行两段的写法，把两段 LRC 和格式说明一起交给它，
       比在这里猜它的语法稳妥（时间戳归它解析，自己不重复实现一遍）。 */
    const toTextPv = () => {
        const lyric = String(current?.lyric ?? '').trim()
        if (!lyric) {
            onToast('还没有选中歌曲，先搜一首或粘贴链接把歌词取回来', 'warn')
            return
        }
        const parts = [lyric]
        const trans = String(current?.trans ?? '').trim()
        // 只有双语开关打开、且这首真有译文时才带译文（和后端保存 LRC 的规则一致）
        if (bilingual && trans) parts.push(trans)
        if (parts.length > 1) {
            parts.push('# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。')
        }
        saveConfig({pvPendingLyrics: parts.join('\n')})
        onNavigate('pv')
    }

    /* ── 登录（网易云：手机号验证码，兜底是 Cookie）───────────── */

    /**
     * 问一次账号：昵称、会员标签、有效期。
     *
     * ⚠️ **必须区分「凭据失效」和「网络不通」**：只有 `expired` 才提示重新登录；
     * `offline`（网络/风控）只当没查到 —— 网络抖一下就把用户显示成未登录、
     * 还引导他重新登录，是错的（后端就是这么分的，别在这里合并掉）。
     */
    const refreshAccount = async (opts?: { renew?: boolean }) => {
        try {
            const a = await api.lyricsAccount()
            if (a.state === 'ok') {
                setAuthExpired(false)
                setNickname(a.nickname ?? '')
                setVip(a.vip ?? '')
                // 临近过期就顺手续一次（该不该续由后端算好）。续期失败只是「这次没续上」，不影响登录态
                if (opts?.renew && a.shouldRenew) void renewLogin()
            } else if (a.state === 'expired') {
                // 置为未登录：清掉跟着凭据走的那几项，状态位让 `loggedIn` 变假
                setAuthExpired(true)
                setNickname('')
                setVip('')
                setMsg('网易云的登录态已经失效，请重新登录（扫码不可用，用短信验证码或换一条 Cookie）。', 'warn')
            }
            // offline / anonymous 什么都不做：前者是网络问题，后者本来就该是空
        } catch {
            // 本地这条查询都失败：不打扰用户，界面保持原样
        }
    }

    /** 续期。服务端是**换发**一个新的 MUSIC_U（旧的也还有效），所以失败不代表掉登录 */
    const renewLogin = async () => {
        setRenewing(true)
        try {
            const r = await api.lyricsRenew()
            // 续期成功说明服务端又认这个账号了，把「已失效」摘掉
            setAuthExpired(false)
            if (r.vip) setVip(r.vip)
            // 新有效期与换发后的凭据都在后端盘上：同步进前端那份，界面才显示得对
            await onRefreshState()
            onToast('网易云登录已续期', 'ok')
        } catch (e) {
            onToast(`续期没成功：${errText(e)}（不影响当前登录）`, 'warn')
        } finally {
            setRenewing(false)
        }
    }

    /** 本地还存着凭据（哪怕服务端已经说它失效）—— 「续期 / 退出登录」按它显示 */
    const hasCookie = !!storedCookie
    /** 状态徽章按它显示：凭据在**且**服务端没说它失效 */
    const loggedIn = hasCookie && !authExpired

    const sendSms = async () => {
        const p = phone.replace(/\D/g, '')
        if (p.length !== 11) {
            setMsg('请填 11 位手机号（不用填 +86）', 'err')
            onToast('手机号要 11 位数字', 'warn')
            return
        }
        setBusy(true)
        setMsg('正在发送验证码…', 'info')
        try {
            await api.lyricsSms(p)
            setSmsLeft(60)
            setMsg(`验证码已发到 ${p}，收到后填在下面。`, 'ok')
            onToast('验证码已发送', 'ok')
        } catch (e) {
            // 号码没注册 / 今天发太多 / 网络不通：原样显示网易云或本地给出的话
            setMsg(errText(e), 'err')
            onToast(errText(e), 'err')
            // 发失败要把按钮放回去（成功的话上面那句会接管它），
            // 否则用户得干等 60 秒才知道短信根本没发出去
            setSmsLeft(0)
        } finally {
            setBusy(false)
        }
    }

    const doLogin = async () => {
        const p = phone.replace(/\D/g, '')
        if (p.length !== 11) {
            setMsg('请填 11 位手机号（不用填 +86）', 'err')
            return
        }
        if (!captcha.trim()) {
            setMsg('请先填短信验证码', 'err')
            return
        }
        setBusy(true)
        setMsg('登录中…', 'info')
        try {
            const res = await api.lyricsCellphone(p, captcha.trim())
            setCaptcha('')
            // 刚登录成功，上一次的「已失效」作废
            setAuthExpired(false)
            setNickname(res.nickname ?? '')
            setVip(res.vip ?? '')
            // 凭据与有效期是**后端**写进 config.json 的：把后端那份同步进内存，
            // 徽章才会从「未登录」变成「已登录为 …」（见 `useNeteaseAuth` 的说明）
            await onRefreshState()
            // 会员标签跟昵称一起报出来（「已登录为 xxx（黑胶SVIP·肆）」）——
            // 它直接影响能拿到哪一档音质，用户看一眼就知道无损为什么拿不到
            const who = [res.nickname, res.vip].filter(Boolean).join('（')
            setMsg(
                who
                    ? `登录成功：${who}${res.vip ? '）' : ''}　登录态已经保存，可以直接搜索取歌词了。`
                    : '登录成功，登录态已经保存，可以直接搜索取歌词了。',
                'ok',
            )
            onToast(res.nickname ? `登录成功：${res.nickname}` : '登录成功', 'ok')
            await onRefreshState()
        } catch (e) {
            // 验证码错误 / 号码没注册 / 接口变更，都要原样显示出来
            setMsg(errText(e), 'err')
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    /** 退出登录：清掉 Cookie。登录态就是 config 里 `neteaseCookie` 一个字段，清空即退出 */
    const doLogout = async () => {
        setBusy(true)
        try {
            await api.lyricsLogout('netease')
            setNickname('')
            setVip('')
            setAuthExpired(false)
            setNeteaseCookie('')
            // 后端已经落盘了：把这一份同步进内存，徽章立刻变回「未登录」
            await onRefreshState()
            setMsg('已退出登录。', 'ok')
            onToast('已退出登录', 'ok')
        } catch (e) {
            setMsg(`退出失败：${errText(e)}`, 'err')
        } finally {
            setBusy(false)
        }
    }

    /**
     * 保存 Cookie。
     *
     * ⚠️ **不给这里做任何字符串处理**：清洗（压掉换行 / 制表符、补 `MUSIC_U=` 前缀）在
     * 后端的 `lyrics::clean_cookie` 一份就够，而且它是**唯一会在用户粘错时报错**的地方。
     * 前端再折一次行，只会掩盖后端看得见的脏数据（两处规则不一致时更难查）。
     *
     * 顺序上先落盘再问账号：`lyricsAccount` 读的是后端那份配置，落盘之前它看不到新值。
     * 留空保存 = 清除（后端语义）。
     */
    const saveCookie = async (raw: string) => {
        if (raw.trim() === MASK) {
            onToast('输入框里显示的是占位「已设置」，不是新的 Cookie', 'warn')
            return
        }
        setBusy(true)
        try {
            const r = await api.saveConfig({neteaseCookie: raw.trim()})
            // 后端回的是清洗过的值（且已打码）：同步进内存，界面与那份配置对齐
            syncConfig(r?.config)
            setNeteaseCookie('')
            // 换了凭据就重新判：存了新的当然要摘掉「已失效」，清空了本来也不该留着
            setAuthExpired(false)
            if (raw.trim()) {
                await refreshAccount()
                onToast('Cookie 已保存', 'ok')
            } else {
                setNickname('')
                setVip('')
                setMsg('已清除网易云的登录态 Cookie，取歌词会退回未登录。', 'warn')
                onToast('Cookie 已清除', 'ok')
            }
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    /* ── 预览用的派生值 ─────────────────────────────────────── */

    /* ⚠️ 必须 memo：整首词是逐行正则 + 排序，而这一页在搜索、翻页、切模式时都会重渲染。 */
    const lines = useMemo(() => parseLrc(doc?.lyric), [doc?.lyric])
    const transAt = useMemo(() => alignTrans(doc?.trans), [doc?.trans])
    const song = doc?.song ?? {}
    const label =
        current?.source === 'file'
            ? `本地文件${ENC_LABEL[doc?.encoding ?? ''] ? `（${ENC_LABEL[doc?.encoding ?? '']}）` : ''}`
            : '网易云'
    /**
     * 凭据还剩几天（负数 = 已经过期）。`null` 表示配置里没记过有效期
     * （只贴了 Cookie 的老配置），此时不显示 —— 不猜一个数字出来。
     */
    const daysLeft = expireAt > 0 ? Math.round((expireAt - Date.now() / 1000) / 86400) : null
    /** 这首歌的收费标签（VIP / 付费专辑 / 低音质免费），免费歌是空串 */
    const fee = feeLabel(song.fee)

    return (
        <div className="lyrics-cols" {...dropProps}>
            {/* ── 左栏：取词的三个入口 ─────────────────────────────── */}
            <div className="lyrics-col">
                <Panel>
                    <PanelHead title={t("搜索歌曲")} desc="点一条取歌词"/>
                    <div className="stack">
                        <Field
                            label="关键词"
                            hint="结果里带专辑、时长与收费标签，信息更全。"
                        >
                            <div className="input-group">
                                <TextInput
                                    value={keyword}
                                    placeholder={t("歌名 / 歌手，回车搜索（例如：千本桜）")}
                                    onChange={(e) => setKeyword(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void doSearch()
                                    }}
                                />
                                <Button variant="primary" icon="search" loading={searching} onClick={doSearch}>
                                    搜索
                                </Button>
                            </div>
                        </Field>

                        {searchErr && <p className="lyrics-error">{searchErr}</p>}

                        {hits === null ? (
                            <p className="hint">{t("搜到的歌会列在这里。")}</p>
                        ) : hits.length === 0 ? (
                            <p className="hint">{t("没有结果。换个关键词再试，或者直接把歌曲链接粘到下面。")}</p>
                        ) : (
                            <div className="lyrics-results">
                                {hits.map((s, i) => (
                                    <button
                                        key={`${asId(s.id) || i}`}
                                        type="button"
                                        className="lyrics-result"
                                        /* 选中的那条留个记号：同名歌在结果里往往有十几个版本，
                                           不回显「现在预览的是哪一条」时，点错一个也看不出来 */
                                        data-current={current?.source !== 'file' && asId(current?.id) === asId(s.id)}
                                        onClick={() => void loadLyric(s.id!, s.playable)}
                                    >
                                        <Icon name="music" size={15}/>
                                        <span className="lyrics-result-text">
                      <span className="lyrics-name">{s.name || '(无标题)'}</span>
                      <span className="lyrics-sub">
                        {s.artists || '未知歌手'}
                          {s.album ? ` · ${s.album}` : ''}
                      </span>
                    </span>
                                        {feeLabel(s.fee) && <Chip tone="warn">{feeLabel(s.fee)}</Chip>}
                                        {s.playable === true && <Chip tone="ok">{t("能下载")}</Chip>}
                                        {s.playable === false && <Chip tone="err">{t("不能下载")}</Chip>}
                                        {!!s.durationSec && <Chip>{fmtDuration(s.durationSec)}</Chip>}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </Panel>

                <Panel>
                    <PanelHead title={t("粘贴链接")} desc="不想搜就复制链接过来；手上有 LRC 文件也可以直接读"/>
                    <div className="stack">
                        <Field
                            label="歌曲链接 / ID"
                            hint="支持网易云歌曲链接（music.163.com/song?id=…、分享出来的 /song/<id>）或直接填歌曲 ID。"
                        >
                            <div className="input-group">
                                <TextInput
                                    value={url}
                                    placeholder={t("粘贴歌曲链接，例如 https://music.163.com/#/song?id=186016")}
                                    onChange={(e) => setUrl(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void doParseLink()
                                    }}
                                />
                                <Button icon="link" loading={pasteLoading} onClick={doParseLink}>
                                    解析链接
                                </Button>
                            </div>
                        </Field>

                        <Field
                            label="从文件导入 .lrc"
                            hint="UTF-8 与 GBK 都能读，读的是哪种会写在歌词预览的来源那一行。`原文 / 译文` 这类双语行会尽量拆出译文。"
                        >
                            <Button icon="folder" onClick={() => void pickLrc()}>
                                选 .lrc 文件
                            </Button>
                            <DropHint dragging={dragging} busy={droppingLrc} text=".lrc 文件也可以直接拖进这个窗口"/>
                        </Field>
                        {importing && <p className="hint">{t("正在读取本地歌词…")}</p>}
                    </div>
                </Panel>

                <Panel>
                    <PanelHead
                        title={t("登录")}
                        desc="手机号验证码，或者填浏览器里的 Cookie"
                        extra={
                            <div className="lyrics-controls">
                                <Chip tone={loggedIn ? 'ok' : 'default'}>
                                    网易云：
                                    {loggedIn ? (nickname ? `已登录为 ${nickname}` : '已登录') : '未登录'}
                                </Chip>
                                {/* 会员标签决定能拿到哪一档音质（无损 / Hi-Res 要会员），所以跟昵称并排给它 */}
                                {loggedIn && vip && <Chip tone="ok">{vip}</Chip>}
                                {loggedIn && daysLeft !== null && (
                                    <Chip tone={daysLeft <= 0 ? 'err' : 'default'}>
                                        {daysLeft <= 0 ? '登录态已过期' : `登录态还剩 ${daysLeft} 天`}
                                    </Chip>
                                )}
                                {/* 凭据失效后仍要能续期、能清掉，所以这两个按「存着凭据」显示，
                                    不按 `loggedIn` —— 否则用户只能重新贴一次 Cookie 才能收拾 */}
                                {hasCookie && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        icon="refresh"
                                        loading={renewing}
                                        onClick={renewLogin}
                                    >
                                        续期
                                    </Button>
                                )}
                                {hasCookie && (
                                    <Button size="sm" variant="ghost" icon="x" loading={busy} onClick={doLogout}>
                                        退出登录
                                    </Button>
                                )}
                            </div>
                        }
                    />
                    <div className="stack">
                        {/* 扫码登录已移除（服务端风控，见 AGENTS.md 第十节）—— 别再往这里加回来 */}
                        <Field
                            label="手机号 + 短信验证码（推荐）"
                            hint="先点「发送验证码」，收到短信后把验证码填在下面点「登录」。"
                        >
                            <div className="input-group">
                                <TextInput
                                    type="tel"
                                    inputMode="numeric"
                                    maxLength={11}
                                    autoComplete="off"
                                    value={phone}
                                    placeholder={t("11 位手机号，不用填 +86")}
                                    onChange={(e) => setPhone(e.target.value)}
                                />
                                <Button
                                    loading={busy && smsLeft === 0}
                                    disabled={smsLeft > 0}
                                    onClick={sendSms}
                                >
                                    {smsLeft > 0 ? `${smsLeft} 秒后可重发` : '发送验证码'}
                                </Button>
                            </div>
                        </Field>
                        <Field label="短信验证码" hint="登录成功后，搜索、取歌词、下封面都会带上它。">
                            <div className="input-group">
                                <TextInput
                                    inputMode="numeric"
                                    maxLength={10}
                                    autoComplete="off"
                                    value={captcha}
                                    placeholder={t("手机收到的短信验证码")}
                                    onChange={(e) => setCaptcha(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void doLogin()
                                    }}
                                />
                                <Button variant="primary" icon="shield" loading={busy} disabled={!captcha.trim()}
                                        onClick={doLogin}>
                                    登录
                                </Button>
                            </div>
                        </Field>

                        {loginMsg && (
                            <p className="lyrics-login-msg" data-tone={loginTone}>
                                {loginMsg}
                            </p>
                        )}

                        <Field
                            label="网易云 Cookie"
                            hint="粘贴进来带换行 / 制表符也没事：保存时会把空白压成一行再存（粘错形状会明确报错）。只粘 MUSIC_U 一格的值也行，程序会自己补上键名。保存后不会回显真实值，只会显示「已设置」。留空保存 = 清除。"
                        >
                            <TextArea
                                rows={3}
                                spellCheck={false}
                                value={neteaseCookie}
                                placeholder={t("MUSIC_U=...　（怎么拿见下面的步骤说明）")}
                                onChange={(e) => setNeteaseCookie(e.target.value)}
                            />
                            <span className="lyrics-controls">
                <Button
                    size="sm"
                    variant="primary"
                    icon="save"
                    onClick={() => void saveCookie(neteaseCookie)}
                >
                  保存
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    onClick={() => void saveCookie('')}
                >
                  清除
                </Button>
              </span>
                        </Field>
                        <p className="lyrics-login-msg">{t("⚠ 等同于账号登录态，别分享、别截图")}</p>

                        {/* 怎么拿 Cookie：用户基本都不知道，写细一点，能照着做 */}
                        <details className="lyrics-help">
                            <summary>{t("怎么拿到 Cookie？（点开看步骤）")}</summary>
                            <div className="lyrics-help-body">
                                <ol>
                                    <li>
                                        用浏览器打开 <code>https://music.163.com</code> 并登录（手机号、验证码都行）。
                                    </li>
                                    <li>
                                        按 <kbd>F12</kbd> 打开开发者工具。
                                    </li>
                                    <li>
                                        切到 <strong>Application</strong> 标签（中文界面是「应用程序」，在顶部一排里）。
                                    </li>
                                    <li>
                                        左边展开 <strong>Cookies</strong>{t(" → 点 ")}<code>https://music.163.com</code>。
                                    </li>
                                    <li>
                                        在列表里找到名为 <code>MUSIC_U</code> 的那一行，双击 Value 那一格，全选复制。
                                    </li>
                                    <li>{t("回到这里粘进上面的框，点「保存」。")}</li>
                                </ol>
                                <p className="lyrics-login-msg">
                                    只复制 MUSIC_U 那一格的值，或把整行 Cookie 粘进来。
                                </p>
                                <p className="lyrics-alert" data-tone="warn">
                                    MUSIC_U 是 HttpOnly cookie，在 Console 里敲 document.cookie 是看不到它的 ——
                                    网上教程那招在这里没用，必须按上面的步骤在 Application → Cookies 里找。
                                </p>
                                <p className="lyrics-alert" data-tone="err">
                                    MUSIC_U 等同账号登录态：不要发给别人、不要贴到群里、不要截图发出来。谁拿到它就能用你的账号。
                                </p>
                            </div>
                        </details>
                    </div>
                </Panel>
            </div>

            {/* ── 右栏：预览 + 保存 ────────────────────────────────── */}
            <div className="lyrics-col">
                <Panel>
                    <PanelHead
                        title={t("歌词预览")}
                        desc="原文与译文分开显示"
                        extra={<SegmentedControl aria-label={t("预览方式")} items={MODES} value={mode}
                                                      onValueChange={setMode}/>}
                    />
                    <div className="stack">
                        {doc ? (
                            <div className="lyrics-meta">
                                {song.cover ? (
                                    // 浏览器直连封面 CDN 不受程序里的代理影响；拉不到就用「下载封面」（那条走后端）
                                    <img
                                        className="lyrics-cover"
                                        src={song.cover}
                                        alt="封面"
                                        onError={(e) => {
                                            e.currentTarget.style.display = 'none'
                                        }}
                                    />
                                ) : null}
                                <div className="lyrics-meta-text">
                                    <span className="lyrics-name">{song.name || '(未取到歌名)'}</span>
                                    <span
                                        className="lyrics-sub">{[song.artists, song.album].filter(Boolean).join(' · ')}</span>
                                    <span className="lyrics-source">
                    {label} · <span className="lyrics-id">{asId(current?.id)}</span>
                                        {song.durationSec ? ` · ${fmtDuration(song.durationSec)}` : ''}
                                        {fee ? ` · ${fee}` : ''}
                  </span>
                                </div>
                            </div>
                        ) : (
                            <p className="hint">{t("还没有选中歌曲。")}</p>
                        )}

                        {previewErr && <p className="lyrics-error">{previewErr}</p>}

                        {doc &&
                            (lines.length === 0 ? (
                                <p className="lyrics-alert" data-tone="warn">
                                    这首歌的歌词里没有可识别的时间轴，无法导出 LRC / SRT。
                                </p>
                            ) : (
                                <div className="lyrics-lines">
                                    {lines.map((l, i) => {
                                        const tr = transAt(l.ms)
                                        return (
                                            <div className="lyrics-line" key={`${l.ms}-${i}`}>
                                                <span className="lyrics-time">{mmss(l.ms)}</span>
                                                {mode !== 'trans' && <span className="lyrics-orig">{l.text}</span>}
                                                {mode !== 'orig' && <span className="lyrics-trans">{tr}</span>}
                                            </div>
                                        )
                                    })}
                                </div>
                            ))}
                    </div>
                </Panel>

                <Panel>
                    <PanelHead title={t("保存")} desc="LRC 给播放器，SRT 给剪辑 / 字幕"/>
                    <div className="stack">
                        <Field
                            label="格式"
                            hint="双语导出：LRC 会在原文下面加一行同时间戳的译文；SRT 会把译文放在同一条字幕的第二行。"
                        >
              <span className="lyrics-controls">
                <SegmentedControl
                    aria-label={t("导出格式")}
                    items={[
                        {value: 'lrc', label: 'LRC'},
                        {value: 'srt', label: 'SRT'},
                    ]}
                    value={format}
                    onValueChange={setFormat}
                />
                <span className="spacer"/>
                <span className="field-hint">{t("双语")}</span>
                <Switch aria-label={t("双语导出")} checked={bilingual} onCheckedChange={setBilingual}/>
              </span>
                        </Field>

                        <Field
                            label="输出目录"
                            hint={`默认是系统下载目录（设置页可改）：${state?.paths?.outputDir || '未读取到'}`}
                        >
                            <DirectoryInput
                                value={outDir}
                                placeholder={t("歌词保存目录…")}
                                onChange={(v) => {
                                    flags.current.edited = true
                                    setOutDir(v)
                                }}
                            />
                        </Field>

                        <Field
                            label="文件名"
                            hint="不用加扩展名，按上面的格式自动补 .lrc / .srt；歌曲按「实际音频格式」补（.mp3 / .flac / .m4a，以文件头为准，不信接口自报的格式），封面按图片真实格式存。歌词文件一律 UTF-8 编码。"
                        >
                            <TextInput
                                value={name}
                                placeholder={t("文件名（默认：歌名 - 歌手）")}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </Field>

                        <Field
                            label="下载音质"
                            hint="档位是「上限」而不是承诺：服务端给不到就按它能拿到的最高档下，并如实写明实际存下来的是哪一档（求无损只给 320K 时不会假装成功）。无损 / Hi-Res 需要对应会员，未登录最高 128K。会员曲 `VIP` / `付费专辑` 只给试听片段，后端会拦下来。"
                        >
                            <SegmentedControl
                                aria-label={t("下载音质")}
                                items={[
                                    {value: 'auto', label: '自动'},
                                    {value: 'lossless', label: '无损'},
                                    {value: 'exhigh', label: '320K'},
                                    {value: 'higher', label: '192K'},
                                    {value: 'standard', label: '128K'},
                                ]}
                                value={quality}
                                onValueChange={setQuality}
                            />
                        </Field>

                        <div className="btn-row">
                            <Button variant="primary" icon="save" loading={saving} onClick={saveLyric}>
                                保存歌词
                            </Button>
                            <Button icon="image" loading={coverLoading} onClick={downloadCover}>
                                下载封面
                            </Button>
                            <Button icon="download" loading={songLoading} onClick={downloadSong}>
                                下载歌曲
                            </Button>
                        </div>

                        {saved && (
                            /* 路径文字放 span 里：按钮有自己的字号与颜色，直接塞进 <p> 会串样式 */
                            <div className="lyrics-saved">
                                <span>已写入：{saved}</span>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    icon="external"
                                    onClick={() =>
                                        api.fsReveal(saved).catch((e: unknown) => onToast(errText(e), 'err'))
                                    }
                                >
                                    打开所在目录
                                </Button>
                            </div>
                        )}

                        <div className="btn-row">
                            <Button icon="film" onClick={toTextPv}>
                                用这段歌词做文字 PV
                            </Button>
                        </div>
                    </div>
                </Panel>

                {/* 许可与出处：歌词文本处理的规则是从 163MusicLyrics 移植的，
                    下载音质与网易云账号这两块参考了 FusionMusicPlayer */}
                <Credit
                    items={[
                        {label: '文本处理', value: 'Apache-2.0', sub: '移植自 163MusicLyrics'},
                        {label: '下载音质 / 账号', value: 'GPL-3.0', sub: '参考了 FusionMusicPlayer'},
                    ]}
                >
                    移植自{' '}
                    <Upstream href="https://github.com/jitwxs/163MusicLyrics">jitwxs/163MusicLyrics</Upstream>
                    （Apache-2.0）；下载档位与回退链、降级如实上报、会员标签与凭据续期参考了{' '}
                    <Upstream href="https://github.com/Janson20/FusionMusicPlayer">
                        Janson20/FusionMusicPlayer
                    </Upstream>
                    （GPL-3.0，照它的做法自行实现，未拷贝其代码）。
                </Credit>
            </div>
        </div>
    )
}
