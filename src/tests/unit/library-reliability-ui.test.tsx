import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryPhotoStatusBadge } from "@/components/LibraryPhotoStatus";
import { LibraryRelinkPreview } from "@/components/LibraryRelinkPreview";
import {
  LibrarySettingsPhoto,
  type PhotoCheckState,
} from "@/components/LibrarySettingsPhoto";
import {
  LibraryAttentionLink,
  LibraryPhotoNotice,
} from "@/components/LibrarySourceLinks";
import type { RelinkPreview } from "@/routes/settings.library";

const CACHED_TEXT = /libraryReliability.detail.cached/;
const NEW_LOCATION_TEXT = /libraryReliability.newLocation/;

const actions = vi.hoisted(() => ({
  getAttention: vi.fn(),
  getMoveCandidates: vi.fn(),
  retryRefresh: vi.fn(),
  inspectMissingRemoval: vi.fn(),
  removeMissing: vi.fn(),
  getRelinkInspection: vi.fn(),
}));
vi.mock("@/actions/library-reliability", () => ({
  libraryReliabilityActions: actions,
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({
    select,
  }: {
    select: (location: { state: { __TSR_index: number } }) => number;
  }) => select({ state: { __TSR_index: 4 } }),
  Link: ({
    to,
    state,
    ...props
  }: {
    to: string;
    state: { libraryReturnIndex: number };
  }) => <a {...props} data-return-index={state.libraryReturnIndex} href={to} />,
}));

let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  actions.getMoveCandidates.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount(children: ReactNode) {
  return render(
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
const photo = {
  id: 7,
  folderId: 1,
  filename: "photo.jpg",
  path: "D:/photos/photo.jpg",
  thumbnailPath: null,
  sourceStatus: "missing" as const,
  refreshStatus: "ready" as const,
  sourceCheckedAt: null,
  sourceAvailableAt: null,
  sourceErrorCode: null,
  refreshError: null,
  pendingMoveCount: 0,
};

it("keeps the check label and only shows a spinner for a longer wait", () => {
  vi.useFakeTimers();
  try {
    const card = (checkState?: PhotoCheckState) => (
      <QueryClientProvider client={client}>
        <LibrarySettingsPhoto
          busy={checkState === "checking"}
          checkState={checkState}
          onCheck={vi.fn()}
          onRelink={vi.fn()}
          onUpdated={vi.fn()}
          photo={photo}
        />
      </QueryClientProvider>
    );
    const { rerender } = render(card());
    const name = "libraryReliability.checkFile";
    const button = screen.getByRole("button", { name });
    const label = within(button).getByText(name);
    const spinner = () => button.querySelector("svg");
    rerender(card("checking"));
    expect(button).toHaveAttribute("aria-busy", "true");
    act(() => vi.advanceTimersByTime(100));
    expect(spinner()).toBeNull();
    rerender(card("done"));
    act(() => vi.advanceTimersByTime(200));
    expect(spinner()).toBeNull();
    expect(label).toBeVisible();

    rerender(card("checking"));
    act(() => vi.advanceTimersByTime(200));
    expect(spinner()).toBeInTheDocument();
    expect(screen.getByRole("button", { name })).toBe(button);
    expect(within(button).getByText(name)).toBe(label);
    rerender(card("done"));
    expect(spinner()).toBeNull();
    expect(label).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});

it("shows a global settings link on faults and removes it after recovery", async () => {
  actions.getAttention.mockResolvedValue({ attentionCount: 0 });
  mount(<LibraryAttentionLink />);
  await waitFor(() => expect(actions.getAttention).toHaveBeenCalledOnce());
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  actions.getAttention.mockResolvedValue({ attentionCount: 2 });
  await client.invalidateQueries({ queryKey: ["libraryHealth"] });
  const link = await screen.findByRole("link", {
    name: "libraryReliability.attentionLink",
  });
  expect(link).toHaveAttribute("href", "/settings/library");
  expect(link).toHaveAttribute("data-return-index", "4");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  actions.getAttention.mockResolvedValue({ attentionCount: 0 });
  await client.invalidateQueries({ queryKey: ["libraryHealth"] });
  await waitFor(() =>
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  );
});

it("keeps normal and pending details quiet and sends the affected photo to settings", () => {
  const resolve = vi.fn();
  const { rerender } = render(
    <LibraryPhotoNotice
      onResolve={resolve}
      photo={{ id: 7, sourceStatus: "available", refreshStatus: "ready" }}
      showingCache={false}
    />
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoNotice
      onResolve={resolve}
      photo={{ id: 7, sourceStatus: "unverified", refreshStatus: "pending" }}
      showingCache={false}
    />
  );
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoNotice
      onResolve={resolve}
      photo={photo}
      showingCache={false}
    />
  );
  expect(screen.getByText("libraryReliability.detail.missing")).toBeVisible();
  expect(
    screen.queryByText("libraryReliability.detail.cached")
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.goToSettings" })
  );
  expect(resolve).toHaveBeenCalledExactlyOnceWith(7);
  expect(screen.getAllByRole("button")).toHaveLength(1);
});

it("mentions cache only after a usable cached preview is shown", () => {
  const { rerender } = render(
    <LibraryPhotoNotice
      photo={{ ...photo, sourceStatus: "offline" }}
      showingCache={false}
    />
  );
  expect(screen.queryByText(CACHED_TEXT)).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoNotice
      photo={{ ...photo, sourceStatus: "offline" }}
      showingCache
    />
  );
  expect(screen.getByText(CACHED_TEXT)).toBeVisible();
});

it("keeps healthy cards quiet while marking real faults", () => {
  const { rerender } = render(
    <LibraryPhotoStatusBadge
      refreshStatus="pending"
      sourceStatus="unverified"
    />
  );
  expect(
    screen.queryByText("libraryReliability.status.pending")
  ).not.toBeInTheDocument();
  rerender(
    <LibraryPhotoStatusBadge refreshStatus="ready" sourceStatus="missing" />
  );
  expect(screen.getByText("libraryReliability.status.missing")).toHaveAttribute(
    "tabindex",
    "0"
  );
});

it("keeps offline recovery safe and sends a missing photo to relinking", () => {
  const check = vi.fn(),
    relink = vi.fn();
  const props = {
    busy: false,
    onUpdated: vi.fn(),
    onCheck: check,
    onRelink: relink,
    onFolder: vi.fn(),
  };
  const { rerender } = mount(
    <LibrarySettingsPhoto
      {...props}
      photo={{ ...photo, sourceStatus: "offline" }}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.check" })
  );
  expect(check).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "libraryReliability.relink" })
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "libraryReliability.remove" })
  ).not.toBeInTheDocument();
  rerender(
    <QueryClientProvider client={client}>
      <LibrarySettingsPhoto {...props} photo={photo} />
    </QueryClientProvider>
  );
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.relink" })
  );
  expect(relink).toHaveBeenCalled();
});

it("previews missing-record relationship loss before removal", async () => {
  actions.inspectMissingRemoval.mockResolvedValue({
    token: "remove",
    photoIds: [7],
    links: { tags: 2, albums: 1, faces: 1, cull: 1 },
  });
  actions.removeMissing.mockResolvedValue({ removed: 1 });
  mount(
    <LibrarySettingsPhoto
      busy={false}
      onCheck={vi.fn()}
      onFolder={vi.fn()}
      onRelink={vi.fn()}
      onUpdated={vi.fn()}
      photo={photo}
    />
  );
  expect(
    screen.getByRole("button", { name: "libraryReliability.checkFile" })
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.remove" })
  );
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("libraryReliability.removeLinks");
  expect(actions.removeMissing).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "libraryReliability.remove" })
  );
  await waitFor(() =>
    expect(actions.removeMissing).toHaveBeenCalledWith("remove")
  );
});

it("requires all weak evidence confirmation before applying", () => {
  const preview: RelinkPreview = {
    token: "preview",
    expiresAt: Date.now() + 600_000,
    total: 101,
    canApply: true,
    unverifiedPhotoIds: [1, 101],
    counts: {
      matched: 0,
      unverified: 2,
      missing: 0,
      mismatch: 0,
      conflict: 0,
      inaccessible: 0,
    },
    items: [
      {
        photoId: 1,
        oldPath: "old.jpg",
        newPath: "new.jpg",
        status: "unverified",
      },
    ],
  };
  const apply = vi.fn();
  render(
    <LibraryRelinkPreview
      busy={false}
      onApply={apply}
      onChange={vi.fn()}
      onClose={vi.fn()}
      preview={preview}
    />
  );
  const submit = screen.getByRole("button", {
    name: "libraryReliability.applyRelink",
  });
  expect(submit).toBeDisabled();
  expect(screen.getByText("libraryReliability.oldLocation")).toBeVisible();
  expect(screen.getByText(NEW_LOCATION_TEXT)).toBeVisible();
  fireEvent.click(screen.getAllByRole("checkbox")[0]);
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  expect(apply).toHaveBeenCalledWith([1, 101]);
});

it("treats offline sources neutrally and never retries updates before restoring access", async () => {
  actions.getAttention.mockResolvedValue({
    attentionCount: 0,
    offlineCount: 3,
  });
  const check = vi.fn();
  mount(
    <>
      <LibraryAttentionLink />
      <LibrarySettingsPhoto
        busy={false}
        onCheck={check}
        onFolder={vi.fn()}
        onRelink={vi.fn()}
        onUpdated={vi.fn()}
        photo={{ ...photo, sourceStatus: "offline", refreshStatus: "failed" }}
      />
    </>
  );
  const link = await screen.findByRole("link", {
    name: "libraryReliability.offlineLink",
  });
  expect(link.parentElement).not.toHaveClass("text-warning");
  expect(
    screen.queryByRole("button", { name: "libraryReliability.retryRefresh" })
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.check" })
  );
  expect(check).toHaveBeenCalledOnce();
  expect(actions.retryRefresh).not.toHaveBeenCalled();
});
it("blocks expired previews and offers a fresh inspection", () => {
  const retry = vi.fn();
  const preview: RelinkPreview = {
    token: "expired",
    expiresAt: Date.now() - 1,
    total: 1,
    canApply: true,
    unverifiedPhotoIds: [],
    counts: {
      matched: 1,
      unverified: 0,
      missing: 0,
      mismatch: 0,
      conflict: 0,
      inaccessible: 0,
    },
    items: [{ photoId: 1, oldPath: "old", newPath: "new", status: "matched" }],
  };
  render(
    <LibraryRelinkPreview
      busy={false}
      onApply={vi.fn()}
      onChange={vi.fn()}
      onClose={vi.fn()}
      onRetry={retry}
      preview={preview}
    />
  );
  expect(
    screen.getByRole("button", { name: "libraryReliability.applyRelink" })
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "libraryReliability.retryLocation" })
  );
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByText("old")).not.toBeInTheDocument();
});
