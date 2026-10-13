import { useEffect, useState } from "react";
import { searchCandidateActions } from "@/actions/search-candidates";
import type { TagInfo } from "@/components/search-bar-utils";
import { buildPersonTrie } from "@/utils/search-suggestions";

interface PersonOption {
  coverPhotoPath: string | null;
  coverThumbnailPath: string | null;
  id: number;
  name: string;
}
interface ExifCandidateResult {
  advancedCategories?: Record<string, string[]>;
  cameraModels?: Array<string | null>;
  creators?: string[];
  lensModels?: Array<string | null>;
}
export function useSearchCandidates() {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [cameraModels, setCameraModels] = useState<string[]>([]);
  const [creators, setCreators] = useState<string[]>([]);
  const [lensModels, setLensModels] = useState<string[]>([]);
  const [advancedCategories, setAdvancedCategories] = useState<
    Record<string, string[]>
  >({});
  // Person identities for search suggestions and AI-powered dictionary suggestions
  const [personOptions, setPersonOptions] = useState<PersonOption[]>([]);
  const [dictSuggestionsEnabled, setDictSuggestionsEnabled] = useState(false);
  // Fetch person names for search suggestions
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await searchCandidateActions.people();
        if (!cancelled && Array.isArray(result)) {
          const options: PersonOption[] = result
            .filter((f) => f.name?.trim())
            .map((f) => ({
              id: Number(f.id),
              name: f.name.trim(),
              coverThumbnailPath: f.coverThumbnailPath ?? null,
              coverPhotoPath: f.coverPhotoPath ?? null,
            }));
          setPersonOptions(options);
          const names = options.map((o) => o.name);
          if (names.length > 0) {
            buildPersonTrie(names);
          }
        }
      } catch {
        // Face module may not be ready
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Enable AI dictionary suggestions once tags are loaded
  useEffect(() => {
    if (tags.length > 0) {
      setDictSuggestionsEnabled(true);
    }
  }, [tags]);

  useEffect(() => {
    let generation = 0;
    function refreshTags() {
      const current = ++generation;
      searchCandidateActions
        .tags()
        .then((result) => {
          if (current === generation) {
            setTags((result as TagInfo[]) || []);
          }
        })
        .catch(() => {
          /* keep the last successful list */
        });
    }
    window.addEventListener("tags-changed", refreshTags);
    refreshTags();
    return () => {
      generation++;
      window.removeEventListener("tags-changed", refreshTags);
    };
  }, []);

  useEffect(() => {
    searchCandidateActions
      .exif()
      .then((r: ExifCandidateResult) => {
        setCameraModels(
          (r.cameraModels || []).filter(
            (model): model is string => model !== null
          )
        );
        setCreators(r.creators || []);
        setLensModels(
          (r.lensModels || []).filter(
            (model): model is string => model !== null
          )
        );
        setAdvancedCategories(r.advancedCategories || {});
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  return {
    tags,
    cameraModels,
    creators,
    lensModels,
    advancedCategories,
    personOptions,
    dictSuggestionsEnabled,
  };
}
