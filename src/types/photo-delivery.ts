import { z } from "zod";

export const deliveryDisclosureSchema = z.object({
  filenames: z.boolean().default(false),
  captureDetails: z.boolean().default(false),
  tags: z.boolean().default(false),
});

export type DeliveryDisclosure = z.output<typeof deliveryDisclosureSchema>;

export const DEFAULT_DELIVERY_DISCLOSURE: DeliveryDisclosure = {
  filenames: false,
  captureDetails: false,
  tags: false,
};
