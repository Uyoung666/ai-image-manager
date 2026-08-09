// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/correctness/useExhaustiveDependencies: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/suspicious/noArrayIndexKey: scoped component lint cleanup preserves existing UI behavior
import { Check, Plus, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FilterDropdown } from "@/components/filter-dropdown";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";
import i18n from "@/localization/i18n";
import { getTagDisplayName } from "@/localization/tag-display";

interface TagInfo {
  color: string | null;
  id: number;
  name: string;
}

type RuleType =
  | "dateRange"
  | "cameraModel"
  | "lensModel"
  | "tags"
  | "focalLength"
  | "aperture"
  | "iso"
  | "fileFormat";
type DatePreset =
  | "smartPresetLastYearToday"
  | "smartPresetLast7Days"
  | "smartPresetLast30Days"
  | "smartPresetThisYear"
  | "smartPresetCustom";
type StringOp = "operatorEquals" | "operatorContains";
type NumberOp = "operatorGte" | "operatorLte" | "operatorRange";
type TagsOp = "operatorContainsAny" | "operatorContainsAll";

interface ExifCandidates {
  apertures: string[];
  cameraModels: string[];
  focalLengths: string[];
  formats: string[];
  isos: number[];
  lensModels: string[];
}

const TAG_SPLIT_REGEX = /[,，\s]+/;

interface SmartRule {
  dateFrom?: string;
  datePreset?: DatePreset;
  dateTo?: string;
  max?: string;
  numberOp?: NumberOp;
  stringOp?: StringOp;
  tagsOp?: TagsOp;
  type: RuleType;
  value: string;
}

const RULE_LABELS: Record<RuleType, string> = {
  dateRange: "smartRuleDateTaken",
  cameraModel: "smartRuleCameraModel",
  lensModel: "smartRuleLensModel",
  tags: "smartRuleTags",
  focalLength: "smartRuleFocalLength",
  aperture: "smartRuleAperture",
  iso: "ISO",
  fileFormat: "smartRuleFileFormat",
};

const DATE_PRESETS: DatePreset[] = [
  "smartPresetLastYearToday",
  "smartPresetLast7Days",
  "smartPresetLast30Days",
  "smartPresetThisYear",
  "smartPresetCustom",
];
const FORMATS = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "avif",
  "tiff",
  "heic",
  "gif",
  "bmp",
  "ico",
  // RAW formats
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "arw",
  "srf",
  "sr2",
  "dng",
  "orf",
  "rw2",
  "raf",
  "pef",
  "rwl",
  "3fr",
  "raw",
];

function toSmartPresetValue(preset: DatePreset): string {
  switch (preset) {
    case "smartPresetLastYearToday":
      return i18n.t("smartPresetLastYearToday");
    case "smartPresetLast7Days":
      return i18n.t("smartPresetLast7Days");
    case "smartPresetLast30Days":
      return i18n.t("smartPresetLast30Days");
    case "smartPresetThisYear":
      return i18n.t("smartPresetThisYear");
    case "smartPresetCustom":
      return i18n.t("smartPresetCustom");
    default:
      return i18n.t("smartPresetCustom");
  }
}

function toStringOperatorValue(operator: StringOp): string {
  return operator === "operatorEquals"
    ? i18n.t("operatorEquals")
    : i18n.t("operatorContains");
}

function toNumberOperatorValue(operator: NumberOp): string {
  if (operator === "operatorLte") {
    return "<=";
  }
  return operator === "operatorRange" ? i18n.t("operatorRange") : ">=";
}

function toTagsOperatorValue(operator: TagsOp): string {
  return operator === "operatorContainsAll"
    ? i18n.t("operatorContainsAll")
    : i18n.t("operatorContainsAny");
}

function AutocompleteInput({
  value,
  onChange,
  placeholder,
  suggestions,
}: {
  onChange: (val: string) => void;
  placeholder: string;
  suggestions: string[];
  value: string;
}) {
  const listId = useId();
  const [showDropdown, setShowDropdown] = useState(false);
  const filtered = suggestions.filter(
    (s) => s.toLowerCase().includes(value.toLowerCase()) && s !== value
  );
  const display = filtered.slice(0, 8);
  // Datalist fallback: native browser autocomplete when dropdown is hidden
  const datalistId = `${listId}-datalist`;

  return (
    <Popover
      onOpenChange={setShowDropdown}
      open={display.length > 0 && showDropdown}
    >
      <PopoverAnchor asChild>
        <div className="relative min-w-0 flex-[1_1_10rem]">
          <input
            className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            list={datalistId}
            onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
            onChange={(e) => {
              onChange(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => setShowDropdown(true)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setShowDropdown(false);
              }
            }}
            placeholder={placeholder}
            value={value}
          />
          <datalist id={datalistId}>
            {suggestions.slice(0, 200).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
      </PopoverAnchor>
      {display.length > 0 && showDropdown && (
        <PopoverContent
          align="start"
          className="z-[60] max-h-[min(10rem,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-1rem)] gap-0 overflow-y-auto overscroll-contain rounded-[4px] border border-input bg-card p-0 shadow-lg"
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          sideOffset={2}
        >
          {display.map((s) => (
            <button
              className="block w-full whitespace-normal px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors [overflow-wrap:anywhere] hover:bg-primary/10 hover:text-foreground"
              key={s}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s);
                setShowDropdown(false);
              }}
              type="button"
            >
              {s}
            </button>
          ))}
        </PopoverContent>
      )}
    </Popover>
  );
}

function TagSelector({
  existingTags,
  value,
  onChange,
}: {
  existingTags: TagInfo[];
  value: string;
  onChange: (val: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const selected = value.split(TAG_SPLIT_REGEX).filter(Boolean);
  const [filterText, setFilterText] = useState("");

  function toggleTag(tagName: string) {
    const set = new Set(selected);
    if (set.has(tagName)) {
      set.delete(tagName);
    } else {
      set.add(tagName);
    }
    onChange([...set].join(", "));
  }

  const filtered = existingTags.filter(
    (t) =>
      !filterText || t.name.toLowerCase().includes(filterText.toLowerCase())
  );

  return (
    <div className="min-w-0 flex-[1_1_14rem] flex-col gap-1">
      <input
        className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
        onChange={(e) => setFilterText(e.target.value)}
        placeholder={t("smartAlbumSearchTags")}
        value={filterText}
      />
      {existingTags.length > 0 ? (
        <div className="flex max-h-[80px] flex-wrap gap-1 overflow-y-auto rounded-[4px] border border-input bg-card p-1.5">
          {filtered.map((tag) => {
            const isSelected = selected.includes(tag.name);
            return (
              <button
                className={`flex min-w-0 max-w-full items-center gap-0.5 rounded-[4px] px-1.5 py-0.5 text-[10px] transition-colors ${
                  isSelected
                    ? "bg-primary/20 text-primary"
                    : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                }`}
                key={tag.id}
                onClick={() => toggleTag(tag.name)}
                type="button"
              >
                {isSelected && <Check className="h-2.5 w-2.5 shrink-0" />}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="min-w-0 truncate">
                      {getTagDisplayName(tag.name, i18n.language)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                    {getTagDisplayName(tag.name, i18n.language)}
                  </TooltipContent>
                </Tooltip>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <span className="px-1 text-[10px] text-muted-foreground">
              {t("smartAlbumNoMatchingTags")}
            </span>
          )}
        </div>
      ) : (
        <span className="px-1 text-[10px] text-muted-foreground">
          {t("smartAlbumNoTags")}
        </span>
      )}
    </div>
  );
}

interface Props {
  onClose: () => void;
  onCreated: () => void;
  open: boolean;
}

export function SmartAlbumDialog({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rules, setRules] = useState<SmartRule[]>([]);
  const [creating, setCreating] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewTimer, setPreviewTimer] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [existingTags, setExistingTags] = useState<TagInfo[]>([]);
  const [candidates, setCandidates] = useState<ExifCandidates>({
    cameraModels: [],
    lensModels: [],
    focalLengths: [],
    apertures: [],
    isos: [],
    formats: [],
  });

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setRules([]);
      setPreviewCount(null);
      setCreating(false);
      ipc.client.photos
        .getTags()
        .then((result) => {
          setExistingTags(result as unknown as TagInfo[]);
        })
        .catch(() => undefined);
      ipc.client.photos
        .getExifCandidates()
        .then((result) => {
          setCandidates(result as unknown as ExifCandidates);
        })
        .catch(() => undefined);
    }
  }, [open]);

  function suggestionsFor(ruleType: RuleType): string[] {
    switch (ruleType) {
      case "cameraModel":
        return candidates.cameraModels;
      case "lensModel":
        return candidates.lensModels;
      case "focalLength":
        return candidates.focalLengths.map(String);
      case "aperture":
        return candidates.apertures.map((v) => Number(v).toFixed(1));
      case "iso":
        return candidates.isos.map(String);
      case "fileFormat":
        return candidates.formats.map((f) => f.toUpperCase());
      default:
        return [];
    }
  }

  function buildRulesJson(): string {
    const mapped = rules.map((r): Record<string, unknown> => {
      const base = { type: r.type };
      switch (r.type) {
        case "dateRange":
          if (r.datePreset && r.datePreset !== "smartPresetCustom") {
            return { ...base, preset: toSmartPresetValue(r.datePreset) };
          }
          return {
            ...base,
            ...(r.dateFrom ? { dateFrom: new Date(r.dateFrom).getTime() } : {}),
            ...(r.dateTo
              ? { dateTo: new Date(r.dateTo).setHours(23, 59, 59, 999) }
              : {}),
          };
        case "cameraModel":
        case "lensModel":
          return {
            ...base,
            operator: toStringOperatorValue(r.stringOp || "operatorContains"),
            value: r.value,
          };
        case "tags":
          return {
            ...base,
            operator: toTagsOperatorValue(r.tagsOp || "operatorContainsAny"),
            value: r.value.split(TAG_SPLIT_REGEX).filter(Boolean),
          };
        case "focalLength":
        case "aperture":
        case "iso":
          return {
            ...base,
            operator: toNumberOperatorValue(r.numberOp || "operatorGte"),
            value: Number(r.value),
            ...(r.numberOp === "operatorRange" && r.max
              ? { max: Number(r.max) }
              : {}),
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
    if (previewTimer) {
      clearTimeout(previewTimer);
    }
    const timer = setTimeout(async () => {
      try {
        const rulesJson = buildRulesJson();
        const result = (await ipc.client.albums.validateSmartAlbumRules({
          smartRules: rulesJson,
        })) as { matchCount?: number };
        setPreviewCount(result.matchCount ?? 0);
      } catch {
        setPreviewCount(null);
      }
    }, 400);
    setPreviewTimer(timer);
  }

  useEffect(() => {
    if (rules.length > 0) {
      updatePreview();
    } else {
      setPreviewCount(null);
    }
    return () => {
      if (previewTimer) {
        clearTimeout(previewTimer);
      }
    };
  }, [rules, updatePreview, previewTimer]);

  function addRule() {
    setRules((prev) => [
      ...prev,
      { type: "dateRange", datePreset: "smartPresetLastYearToday", value: "" },
    ]);
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateRule(idx: number, patch: Partial<SmartRule>) {
    setRules((prev) =>
      prev.map((r, i) => {
        if (i !== idx) {
          return r;
        }
        if (patch.type && patch.type !== r.type) {
          const defaults: SmartRule = { type: patch.type, value: "" };
          if (patch.type === "dateRange") {
            defaults.datePreset = "smartPresetLastYearToday";
          } else if (
            patch.type === "cameraModel" ||
            patch.type === "lensModel"
          ) {
            defaults.stringOp = "operatorContains";
          } else if (
            patch.type === "focalLength" ||
            patch.type === "aperture" ||
            patch.type === "iso"
          ) {
            defaults.numberOp = "operatorGte";
          } else if (patch.type === "tags") {
            defaults.tagsOp = "operatorContainsAny";
          }
          return { ...defaults, ...patch };
        }
        return { ...r, ...patch };
      })
    );
  }

  async function handleCreate() {
    if (!name.trim() || rules.length === 0) {
      return;
    }
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
    } catch {
      /* ignore */
    }
    setCreating(false);
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || creating)) {
          if (rules.length > 0) {
            setShowCloseConfirm(true);
          } else {
            onClose();
          }
        }
      }}
      open={open}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden overscroll-contain"
        onEscapeKeyDown={(e) => {
          if (creating) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (creating) {
            e.preventDefault();
          }
        }}
        showCloseButton={!creating}
        size="xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("smartAlbumCreateTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <input
            autoFocus
            className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            onChange={(e) => setName(e.target.value)}
            placeholder={t("smartAlbumNamePlaceholder")}
            value={name}
          />
          <input
            className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("smartAlbumDescriptionPlaceholder")}
            value={description}
          />
        </div>

        <div>
          <label
            className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider"
            htmlFor="smart-album-rules"
          >
            {t("smartAlbumRulesLabel")}
          </label>
          <div className="space-y-2" id="smart-album-rules">
            {rules.map((rule, idx) => (
              <div
                className="flex min-w-0 flex-wrap items-start gap-1.5 rounded-[6px] border border-border bg-card p-2"
                key={idx}
              >
                <FilterDropdown
                  ariaLabel={t("smartAlbumRulesLabel")}
                  className="w-full min-w-0"
                  onChange={(value) =>
                    updateRule(idx, { type: value as RuleType })
                  }
                  options={Object.entries(RULE_LABELS).map(
                    ([value, label]) => ({
                      label: t(label),
                      value,
                    })
                  )}
                  placeholder={t("smartAlbumRulesLabel")}
                  value={rule.type}
                  wrapperClassName="min-w-0 flex-[1_1_9rem]"
                />

                {rule.type === "dateRange" && (
                  <FilterDropdown
                    ariaLabel={t("smartRuleDateTaken")}
                    className="w-full min-w-0"
                    onChange={(value) =>
                      updateRule(idx, {
                        datePreset: value as DatePreset,
                        value: "",
                      })
                    }
                    options={DATE_PRESETS.map((value) => ({
                      label: t(value),
                      value,
                    }))}
                    placeholder={t("smartRuleDateTaken")}
                    value={rule.datePreset || "smartPresetLastYearToday"}
                    wrapperClassName="min-w-0 flex-[1_1_9rem]"
                  />
                )}
                {(rule.type === "cameraModel" || rule.type === "lensModel") && (
                  <FilterDropdown
                    ariaLabel={t(RULE_LABELS[rule.type])}
                    className="w-full min-w-0"
                    onChange={(value) =>
                      updateRule(idx, {
                        stringOp: value as StringOp,
                      })
                    }
                    options={[
                      {
                        label: t("operatorContains"),
                        value: "operatorContains",
                      },
                      { label: t("operatorEquals"), value: "operatorEquals" },
                    ]}
                    placeholder={t(RULE_LABELS[rule.type])}
                    value={rule.stringOp || "operatorContains"}
                    wrapperClassName="min-w-0 flex-[1_1_8rem]"
                  />
                )}
                {(rule.type === "focalLength" ||
                  rule.type === "aperture" ||
                  rule.type === "iso") && (
                  <FilterDropdown
                    ariaLabel={t(RULE_LABELS[rule.type])}
                    className="w-full min-w-0"
                    onChange={(value) =>
                      updateRule(idx, {
                        numberOp: value as NumberOp,
                      })
                    }
                    options={[
                      { label: t("operatorGte"), value: "operatorGte" },
                      { label: t("operatorLte"), value: "operatorLte" },
                      { label: t("operatorRange"), value: "operatorRange" },
                    ]}
                    placeholder={t(RULE_LABELS[rule.type])}
                    value={rule.numberOp || "operatorGte"}
                    wrapperClassName="min-w-0 flex-[1_1_8rem]"
                  />
                )}
                {rule.type === "tags" && (
                  <FilterDropdown
                    ariaLabel={t("smartRuleTags")}
                    className="w-full min-w-0"
                    onChange={(value) =>
                      updateRule(idx, { tagsOp: value as TagsOp })
                    }
                    options={[
                      {
                        label: t("operatorContainsAny"),
                        value: "operatorContainsAny",
                      },
                      {
                        label: t("operatorContainsAll"),
                        value: "operatorContainsAll",
                      },
                    ]}
                    placeholder={t("smartRuleTags")}
                    value={rule.tagsOp || "operatorContainsAny"}
                    wrapperClassName="min-w-0 flex-[1_1_9rem]"
                  />
                )}

                {rule.type === "dateRange" &&
                (rule.datePreset === "smartPresetCustom" ||
                  !rule.datePreset) ? (
                  <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-center gap-1">
                    <input
                      className="h-7 min-w-[8rem] flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none focus:border-primary"
                      onChange={(e) =>
                        updateRule(idx, { dateFrom: e.target.value })
                      }
                      type="date"
                      value={rule.dateFrom || ""}
                    />
                    <span className="text-[11px] text-muted-foreground">
                      {t("dateRangeTo")}
                    </span>
                    <input
                      className="h-7 min-w-[8rem] flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none focus:border-primary"
                      onChange={(e) =>
                        updateRule(idx, { dateTo: e.target.value })
                      }
                      type="date"
                      value={rule.dateTo || ""}
                    />
                  </div>
                ) : rule.type === "fileFormat" ? (
                  <FilterDropdown
                    ariaLabel={t("smartRuleFileFormat")}
                    className="w-full min-w-0"
                    onChange={(value) => updateRule(idx, { value })}
                    options={[
                      { label: t("chooseFormat"), value: "" },
                      ...FORMATS.map((value) => ({
                        label: value.toUpperCase(),
                        value,
                      })),
                    ]}
                    placeholder={t("chooseFormat")}
                    value={rule.value}
                    wrapperClassName="min-w-0 flex-[1_1_10rem]"
                  />
                ) : rule.type === "tags" ? (
                  <TagSelector
                    existingTags={existingTags}
                    onChange={(val) => updateRule(idx, { value: val })}
                    value={rule.value}
                  />
                ) : rule.type === "dateRange" ? null : (
                  <div className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center gap-1">
                    {/* Autocomplete wrapper */}
                    <AutocompleteInput
                      onChange={(val) => updateRule(idx, { value: val })}
                      placeholder={t("valuePlaceholder")}
                      suggestions={suggestionsFor(rule.type)}
                      value={rule.value}
                    />
                    {(rule.type === "focalLength" ||
                      rule.type === "aperture" ||
                      rule.type === "iso") &&
                      rule.numberOp === "operatorRange" && (
                        <input
                          className="h-7 min-w-20 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                          onChange={(e) =>
                            updateRule(idx, { max: e.target.value })
                          }
                          placeholder={t("maxValuePlaceholder")}
                          value={rule.max || ""}
                        />
                      )}
                  </div>
                )}

                <button
                  className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-destructive"
                  onClick={() => removeRule(idx)}
                  type="button"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}

            <button
              className="flex w-full items-center justify-center gap-1 rounded-[6px] border border-input border-dashed px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              onClick={addRule}
              type="button"
            >
              <Plus className="h-3 w-3" />
              {t("smartAlbumAddRule")}
            </button>
          </div>
        </div>

        {previewCount !== null && (
          <div className="rounded-[6px] bg-success/10 px-3 py-2 text-[12px] text-success">
            {t("smartAlbumMatchedCount", { count: previewCount })}
          </div>
        )}

        <DialogFooter>
          <button
            className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
            disabled={creating}
            onClick={onClose}
            type="button"
          >
            {t("cancel")}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={!name.trim() || rules.length === 0 || creating}
            onClick={handleCreate}
            type="button"
          >
            {creating && <LoadingSpinner size="sm" variant="inherit" />}
            {t("smartAlbumCreateTitle")}
          </button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        confirmText={t("confirm")}
        description={t("smartAlbumDiscardDesc")}
        onCancel={() => setShowCloseConfirm(false)}
        onConfirm={() => {
          setShowCloseConfirm(false);
          onClose();
        }}
        open={showCloseConfirm}
        title={t("smartAlbumDiscardTitle")}
      />
    </Dialog>
  );
}
