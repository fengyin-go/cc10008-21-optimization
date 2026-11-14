import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}

export default function Modal({ title, onClose, children, footer }: ModalProps) {
  return (
    <div className="modal-mask" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose()
      }
    }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="link" type="button" onClick={onClose}>关闭</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  )
}
