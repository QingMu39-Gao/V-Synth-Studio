import type {Announcement} from './api'

/**
 * 公告的「读过没读过」—— 只记 id。
 *
 * 抽出来是为了能测：这一处错了的表现是「同一条公告每次启动都弹」或者「新公告不弹」，
 * 而两种都不会报错。
 */

/**
 * 还没读过的那几条（`items` 已由后端按日期新的在前排好，这里保持顺序）。
 *
 * ⚠️ 只按 `id` 比：没有 id 的条目后端已经用标题兜底了，所以这里不用再兜一次。
 */
export function unseen(
    items: Announcement[] | undefined | null,
    seen: string[] | undefined | null,
): Announcement[] {
    const read = new Set((seen ?? []).filter((s) => typeof s === 'string' && s))
    return (items ?? []).filter((a) => !!a && typeof a.id === 'string' && !!a.id && !read.has(a.id))
}

/**
 * 记一条已读，回新的已读清单。
 *
 * ⚠️ **要封顶**：这个数组进 `config.json`，公告发得多了会一直长。只留最近的
 * `cap` 条 —— 丢掉的都是很老的公告，而「已读」这件事只需要覆盖还在服务器上的那些。
 */
export function markSeen(
    seen: string[] | undefined | null,
    id: string,
    cap = 100,
): string[] {
    const list = (seen ?? []).filter((s) => typeof s === 'string' && s && s !== id)
    list.push(id)
    return list.slice(-cap)
}
