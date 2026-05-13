import { Sparkles, X, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/ipc/manager";

type RuleType = "dateRange" | "cameraModel" | "lensModel" | "tags" | "focalLength" | "aperture" | "iso" | "fileFormat";
type DatePreset = "去年今日" | "最近7天" | "最近30天" | "今年" | "自定义";
type StringOp = "等于" | "包含";
type NumberOp = ">=" | "<=" | "范围";
type TagsOp = "包含任一" | "包含全部";

interface SmartRule {
  type: RuleType;
  datePreset?: DatePreset;
  stringOp?: StringOp;
  numberOp?: NumberOp;
  tagsOp?: TagsOp;
  value: string;
  max?: string;
}

const RULE_LABELS: Record<RuleType, string> = {
  dateRange: "拍摄日期",
  cameraModel: "相机型号",
  lensModel: "镜头型号",
  tags: "标签",
  focalLength: "焦段",
  aperture: "光圈",
  iso: "ISO",
  fileFormat: "文件格式",
};

const DATE_PRESETS: DatePreset[] = ["去年今日", "最近7天", "最近30天", "今年", "自定义"];
const FORMATS = ["jpg", "jpeg", "png", "webp", "avif", "tiff", "heic", "gif", "bmp"];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function SmartAlbumDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<SmartRule[]>([]);
  const [creating, setCreating] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewTimer, setPreviewTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setRules([]);
      setPreviewCount(null);
      setCreating(false);
    }
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open, onClose]);

  function buildRulesJson(): string {
    const mapped = rules.map((r): Record<string, unknown> => {
      const base = { type: r.type };
      switch (r.type) {
        case "dateRange":
          if (r.datePreset && r.datePreset !== "自定义") {
            return { ...base, preset: r.datePreset };
          }
          return { ...base, value: r.value };
        case "cameraModel":
        case "lensModel":
          return { ...base, operator: r.stringOp || "包含", value: r.value };
        case "tags":
          return { ...base, operator: r.tagsOp || "包含任一", value: r.value.split(/[,，]\s*/).filter(Boolean) };
        case "focalLength":
        case "aperture":
        case "iso":
          return {
            ...base,
            operator: r.numberOp || ">=",
            value: Number(r.value),
            ...(r.numberOp === "范围" && r.max ? { max: Number(r.max) } : {}),
          };
        case "fileFormat":
          return { ...base, value: r.value };
        default:
          return base;
      }
    });
    return JSON.stringify({ rules: mapped });
  }

  function updatePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    const timer = setTimeout(async () => {
      try {
        const rulesJson = buildRulesJson();
        const result = await ipc.client.albums.validateSmartAlbumRules({ smartRules: rulesJson }) as { matchCount?: number };
        setPreviewCount(result.matchCount ?? 0);
      } catch {
        setPreviewCount(null);
      }
    }, 400);
    setPreviewTimer(timer);
  }

  useEffect(() => {
    if (rules.length > 0) updatePreview();
    else setPreviewCount(null);
    return () => {
      if (previewTimer) clearTimeout(previewTimer);
    };
  }, [rules]);

  function addRule() {
    setRules((prev) => [...prev, { type: "dateRange", datePreset: "去年今日", value: "" }]);
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRule(idx: number, patch: Partial<SmartRule>) {
    setRules((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        if (patch.type && patch.type !== r.type) {
          // Reset value fields on type change
          const defaults: SmartRule = { type: patch.type, value: "" };
          if (patch.type === "dateRange") defaults.datePreset = "去年今日";
          else if (patch.type === "cameraModel" || patch.type === "lensModel") defaults.stringOp = "包含";
          else if (patch.type === "focalLength" || patch.type === "aperture" || patch.type === "iso") defaults.numberOp = ">=";
          else if (patch.type === "tags") defaults.tagsOp = "包含任一";
          return { ...defaults, ...patch };
        }
        return { ...r, ...patch };
      })
    );
  }

  async function handleCreate() {
    if (!name.trim() || rules.length === 0) return;
    setCreating(true);
    try {
      await ipc.client.albums.createAlbum({
        name: name.trim(),
        description: description.trim() || undefined,
        isSmart: true,
        smartRules: buildRulesJson(),
      });
      onCreated();
      onClose();
    } catch { /* ignore */ }
    setCreating(false);
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      ref={overlayRef}
    >
      <div className="w-[520px] max-h-[80vh] overflow-y-auto rounded-[12px] border border-border bg-popover ring-1 ring-white/5">
        {/* Header */}
        <div className="flex items-center justify-between border-border border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="font-[590] text-[16px] text-foreground">创建智能相册</h2>
          </div>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Name & Description */}
          <div className="space-y-2">
            <input
              autoFocus
              className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
              onChange={(e) => setName(e.target.value)}
              placeholder="相册名称"
              value={name}
            />
            <input
              className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述 (可选)"
              value={description}
            />
          </div>

          {/* Rules */}
          <div>
            <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
              匹配规则 (满足所有条件)
            </label>
            <div className="space-y-2">
              {rules.map((rule, idx) => (
                <div className="flex items-center gap-1.5 rounded-[6px] border border-border bg-card p-2" key={idx}>
                  {/* Type */}
                  <select
                    className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                    onChange={(e) => updateRule(idx, { type: e.target.value as RuleType })}
                    value={rule.type}
                  >
                    {Object.entries(RULE_LABELS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>

                  {/* Operator */}
                  {rule.type === "dateRange" && (
                    <select
                      className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                      onChange={(e) => updateRule(idx, { datePreset: e.target.value as DatePreset, value: "" })}
                      value={rule.datePreset || "去年今日"}
                    >
                      {DATE_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}
                  {(rule.type === "cameraModel" || rule.type === "lensModel") && (
                    <select
                      className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                      onChange={(e) => updateRule(idx, { stringOp: e.target.value as StringOp })}
                      value={rule.stringOp || "包含"}
                    >
                      <option value="包含">包含</option>
                      <option value="等于">等于</option>
                    </select>
                  )}
                  {(rule.type === "focalLength" || rule.type === "aperture" || rule.type === "iso") && (
                    <select
                      className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                      onChange={(e) => updateRule(idx, { numberOp: e.target.value as NumberOp })}
                      value={rule.numberOp || ">="}
                    >
                      <option value=">=">大于等于</option>
                      <option value="<=">小于等于</option>
                      <option value="范围">范围</option>
                    </select>
                  )}
                  {rule.type === "tags" && (
                    <select
                      className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                      onChange={(e) => updateRule(idx, { tagsOp: e.target.value as TagsOp })}
                      value={rule.tagsOp || "包含任一"}
                    >
                      <option value="包含任一">包含任一</option>
                      <option value="包含全部">包含全部</option>
                    </select>
                  )}

                  {/* Value */}
                  {rule.type === "dateRange" && (rule.datePreset === "自定义" || !rule.datePreset) ? (
                    <input
                      className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                      onChange={(e) => updateRule(idx, { value: e.target.value })}
                      placeholder="YYYY-MM-DD 或 时间戳"
                      value={rule.value}
                    />
                  ) : rule.type === "fileFormat" ? (
                    <select
                      className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none"
                      onChange={(e) => updateRule(idx, { value: e.target.value })}
                      value={rule.value}
                    >
                      <option value="">选择格式</option>
                      {FORMATS.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
                    </select>
                  ) : rule.type !== "dateRange" ? (
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                        onChange={(e) => updateRule(idx, { value: e.target.value })}
                        placeholder={rule.type === "tags" ? "风景, 海滩" : "值"}
                        value={rule.value}
                      />
                      {(rule.type === "focalLength" || rule.type === "aperture" || rule.type === "iso") && rule.numberOp === "范围" && (
                        <input
                          className="h-7 w-20 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                          onChange={(e) => updateRule(idx, { max: e.target.value })}
                          placeholder="最大值"
                          value={rule.max || ""}
                        />
                      )}
                    </div>
                  ) : null}

                  <button
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-[#e5484d]"
                    onClick={() => removeRule(idx)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}

              <button
                className="flex w-full items-center justify-center gap-1 rounded-[6px] border border-dashed border-input px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
                onClick={addRule}
              >
                <Plus className="h-3 w-3" />
                添加规则
              </button>
            </div>
          </div>

          {/* Preview */}
          {previewCount !== null && (
            <div className="rounded-[6px] bg-[#46a758]/10 px-3 py-2 text-[12px] text-[#46a758]">
              匹配到 {previewCount} 张照片
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!name.trim() || rules.length === 0 || creating}
              onClick={handleCreate}
            >
              {creating && (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              创建智能相册
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
