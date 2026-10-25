import {Switch} from '@/components/ui'
import './SwitchRow.css'

/** 一行开关：左边标签 + 说明，右边开关。 */
export function SwitchRow({
                              label,
                              desc,
                              checked,
                              onChange,
                              disabled,
                              disabledHint,
                          }: {
    label: string
    desc?: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled?: boolean
    disabledHint?: string
}) {
    const text = disabled && disabledHint && desc ? `${desc}（${disabledHint}）` : desc
    return (
        <div className="switch-row">
            <div className="switch-text">
                <span className="switch-label">{label}</span>
                {text ? <span className="switch-desc">{text}</span> : null}
            </div>
            <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange}/>
        </div>
    )
}
