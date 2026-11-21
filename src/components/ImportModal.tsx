import { useRef, useState } from "react";
import { FileText, Loader2, Upload, X } from "lucide-react";
import { SubscriptionRequestFields } from "../SubscriptionCard";
import { defaultSubscriptionRequest, type SubscriptionRequest } from "../workspace";

export function ImportModal({
  ready,
  importing,
  error,
  onClose,
  onImport,
}: {
  ready: boolean;
  importing: boolean;
  error: string;
  onClose: () => void;
  onImport: (text: string, request?: SubscriptionRequest, customName?: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [request, setRequest] = useState<SubscriptionRequest>();
  const file = useRef<HTMLInputElement>(null);
  const isUrl = /^https?:\/\//i.test(text.trim());

  return (
    <div className="overlay" onMouseDown={() => !importing && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="dialog-title">导入订阅或节点</h2>
            <p>支持订阅 URL、分享链接、Base64、Clash YAML、sing-box JSON。</p>
          </div>
          <button
            className="icon-button"
            aria-label="关闭"
            disabled={importing}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <label style={{ display: "grid", gap: 6, marginBottom: 12, fontSize: 13 }}>
          <span>订阅名称（可选）</span>
          <input
            className="field-input"
            placeholder="留空则自动使用域名或「本地订阅」"
            maxLength={80}
            value={name}
            disabled={importing}
            onChange={e => setName(e.target.value)}
          />
        </label>
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="粘贴订阅地址、配置内容或节点链接"
        />
        {isUrl && (
          <details className="subscription-request-details">
            <summary>订阅下载设置（请求线路 / User-Agent / HTTP）</summary>
            <SubscriptionRequestFields
              value={request ?? defaultSubscriptionRequest}
              disabled={importing}
              onChange={setRequest}
            />
          </details>
        )}
        <input
          hidden
          ref={file}
          type="file"
          accept=".txt,.yaml,.yml,.json"
          onChange={async e => {
            const f = e.target.files?.[0];
            if (f) {
              setText(await f.text());
              if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, ""));
            }
          }}
        />
        <div className="modal-actions">
          <button type="button" className="btn" disabled={importing} onClick={() => file.current?.click()}>
            <Upload size={16} />
            选择本地文件
          </button>
          {error && <span className="error" role="alert">{error}</span>}
          <button
            type="button"
            className="btn primary"
            disabled={importing || !ready || !text.trim()}
            onClick={() => void onImport(text, request && { ...request, userAgent: request.userAgent.trim() }, name)}
          >
            {importing && <Loader2 size={14} className="spin" />}
            {importing ? "正在导入…" : "解析并导入"}
          </button>
        </div>
        <p className="privacy">
          <FileText size={14} />
          订阅内容与规则均通过 Windows DPAPI 加密保存在本机。
        </p>
      </div>
    </div>
  );
}
