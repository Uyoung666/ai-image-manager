import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import type { DeliveryDisclosure } from "@/types/photo-delivery";

interface PhotoDeliveryOptionsProps {
  disabled: boolean;
  keepsOriginalNames?: boolean;
  onChange: (value: DeliveryDisclosure) => void;
  value: DeliveryDisclosure;
}

const disclosureOptions = [
  { field: "filenames", label: "deliveryOriginalNames" },
  { field: "captureDetails", label: "deliveryCaptureDetails" },
  { field: "tags", label: "deliveryReviewedTags" },
] as const;

export function PhotoDeliveryOptions({
  disabled,
  keepsOriginalNames,
  onChange,
  value,
}: PhotoDeliveryOptionsProps) {
  const { t } = useTranslation();
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-1 font-medium text-[12px]">
        {t("deliveryInclude")}
      </legend>
      {disclosureOptions
        .filter(({ field }) => !(keepsOriginalNames && field === "filenames"))
        .map(({ field, label }) => (
          <div
            className="flex min-w-0 items-center justify-between gap-3 text-[12px]"
            key={field}
          >
            <span className="min-w-0 [overflow-wrap:anywhere]">{t(label)}</span>
            <Switch
              ariaLabel={t(label)}
              checked={value[field]}
              disabled={disabled}
              onCheckedChange={(checked) =>
                onChange({ ...value, [field]: checked })
              }
            />
          </div>
        ))}
    </fieldset>
  );
}

export function PhotoDeliverySummary({
  count,
  kind,
  value,
  watermarked = false,
}: {
  count: number;
  kind: "original" | "jpeg" | "share";
  value: DeliveryDisclosure;
  watermarked?: boolean;
}) {
  const { t } = useTranslation();
  const outputs = {
    original: "deliveryOriginalSummary",
    jpeg: watermarked ? "deliveryWatermarkedSummary" : "deliveryJpegSummary",
    share: "deliveryShareSummary",
  } as const;
  const names =
    kind === "original" || value.filenames
      ? "deliveryNamesIncluded"
      : "deliveryNumbered";
  const capture = value.captureDetails
    ? "deliveryCaptureIncluded"
    : "deliveryCaptureOmitted";
  const tags = value.tags ? "deliveryTagsIncluded" : "deliveryTagsOmitted";
  return (
    <p
      aria-live="polite"
      className="text-[12px] text-muted-foreground leading-relaxed [overflow-wrap:anywhere]"
    >
      {t("deliverySummary", {
        output: t(outputs[kind], { count }),
        names: t(names),
        capture: t(capture),
        tags: t(tags),
      })}
      {kind === "original" && ` ${t("deliveryOriginalMetadata")}`}
    </p>
  );
}
