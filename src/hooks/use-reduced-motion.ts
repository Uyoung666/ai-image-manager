import { useContext } from "react";
import { UiPreferencesContext } from "@/contexts/ui-preferences-context";

export function useUiPreferences() {
  return useContext(UiPreferencesContext);
}

export function useReducedMotion() {
  return useUiPreferences().reduceMotion;
}
