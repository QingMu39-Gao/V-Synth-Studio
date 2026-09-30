import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'

/**
 * 表单字段。实色，走令牌 —— 内容层的东西，不套玻璃。
 */

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function TextInput({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...rest} className={`input ${className}`} />
}

export function TextArea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={`textarea ${className}`} />
}
