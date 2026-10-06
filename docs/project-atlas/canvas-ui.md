# Canvas UI

How the document canvas behaves: zoom levels, groups and supergroups, overview and drill-down, reading order, navigation history, search, selection, dragging, uploads, and refresh.

## Zoom bands

The canvas changes what it shows as you zoom (`src/canvas-viewport-transitions.ts`):

| Zoom | Band | What you see |
| --- | --- | --- |
| below 0.34 | `overview` | The map: group frames and supergroups with counts, no card bodies |
| 0.34 – 0.75 | `titles` | Cards show titles and metadata |
| 0.75 and above | `full` | Cards render their documents |

- Zooming out below 0.34 opens the overview unless you are entering a file or the map is pinned.
- With the map pinned, zooming **in** past 0.5 on a group enters that group; zooming **out** below 0.21 leaves it.
- The map summary fades in between zoom 0.10 and 0.22.
- The viewport per canvas is remembered, so returning to a canvas restores where you were.

## Groups

A group key looks like `prefix:name[/child…]` (`shared/groups.ts`):

| Prefix | Source | Example |
| --- | --- | --- |
| `lane:` | Reading lane: overview, work (Active work), reference, followup | `lane:reference` |
| `area:` | Work area from the fixed catalog in `shared/work-areas.ts` (frontend, backend, devops, sre, security_engineering, …) grouped into domains | `area:backend` |
| `purpose:` | Document purpose | `purpose:runbook` |
| `custom:` | Named by people or Reflex | `custom:release/operations` |

- Names are lowercase `a-z 0-9 _ -`, up to 64 chars per level, up to 8 levels; the full key is at most 256 chars.
- Older canvases stored bare lane names (`work`); `normalizedGroup` upgrades them to `lane:work`.
- Each group gets a stable color tone from its key (`groupTone`), and display names come from `groupLabels`.
- **Settings → Group by** chooses the default grouping: work area, purpose, or reading lane.

### Supergroups

At overview zoom, top-level groups are clustered into **supergroups** (`src/canvas-hierarchy*.ts`):

1. Count links between documents in different root groups (`hierarchyConnections`).
2. Rank roots by connection degree, then size.
3. Seed a community with the least-connected remaining root, then add the roots with the strongest link affinity, up to 6 roots per supergroup (`hierarchyCommunities`).
4. Present each community with a title and its strongest connections (`presentCommunities`).

### Drill board

Clicking a group in the overview opens the **drill board** (`CanvasDrillBoard.tsx`): child groups first, then the group's documents in reading order, laid out by `drillLayout` with a camera that frames them.

## Reading order

`readingSequence` (`src/reading.ts`) decides the order for previous/next, ← and →, and the document list:

1. Each group gets an anchor at its top-left card; ungrouped cards are their own anchor.
2. Anchors are sorted into rows of 400 px, then left to right.
3. Inside a group, cards go top to bottom, then left to right.

## Navigation and history

| Feature | Detail (`src/useCanvasJourney.ts`, `src/app-navigation.ts`) |
| --- | --- |
| Back/forward journey | Up to 100 places (canvas, document, viewport) |
| Recent documents | Last 12 opened documents |
| Bookmarks | Up to 50 named places, saved in `localStorage` (`symbiknow:bookmarks`) |
| URLs | `?canvas=<id>&doc=<id>` for every open document; the browser Back button works |
| Search | ⌘K / Ctrl+K opens canvas search |
| Escape | Closes the top-most layer first (`useEscapeLayer`), then returns to the canvas |
| Reader | ← / → move through reading order; links at the end of each page continue it |
| Editor | ⌘E / Ctrl+E switches Source / Split / Preview |

Deleting a canvas removes it from the journey (`forgetCanvas`).

## Search on the canvas

`CanvasSearch*.tsx` + `canvas-search-model.ts` call `GET /api/search` and show results grouped by canvas, with filters and a confirmation step before jumping to another canvas. Matching groups in the overview show match counts.

## Selection and focus

- Selecting a card highlights its edges; **related** mode lights up neighbors within 1 or 2 link hops (`relatedIds`).
- Focus mode can pull those neighbors close to the selected card (`pullNeighbors`) without saving new positions.
- The **inspector** panel (`InspectorDetails`, `InspectorActions`, resizable) shows metadata and lets you group, tag, or connect the selected documents.

## Dragging and connecting

- Dragging a card saves its new position; dropping it inside a group frame assigns that group (`droppedBlockPatch`).
- Dragging a group frame moves all its members in one layout write.
- Drawing a connection between two cards saves a link (`canvasConnection`).
- Cards resize, and the size is saved.

## Adding content

| Control | Effect |
| --- | --- |
| **Add block** | New document dialog (title, loader, content) |
| **Upload files** | Uploads `.md`, `.mdx`, `.html` one by one (`app-intake.ts`), reloads the canvas, then shows the last uploaded card |
| **Browse groups** | Group list with counts and quick navigation (`BrowseGroups.tsx`) |
| **Tasks** (sidebar) | Opens the [Tasks board](tasks-board.md) for this canvas |

## Loading and refresh

- The canvas loads with `?summary=1`, which skips document bodies. A card loads its body when it is shown at full zoom or opened (`useDocumentContent`).
- The canvas refreshes every 15 seconds, but only while the tab is visible, no dialog is open, and the user has not clicked or typed in the last 1.5 s. Switching back to the tab also refreshes it.
- Unchanged objects are reused, so cards do not re-render or lose state on refresh.
- If the server goes away, the app shows "server is unavailable" and retries.

## Dialogs and accessibility

- Dialogs share one contract (`app-dialog-contract.ts`) and trap focus (`useModalFocus`), returning focus to the element that opened them.
- Every control has an `aria-label`; the Tasks board has a status select as a keyboard alternative to dragging.
- Motion respects `prefers-reduced-motion`.
