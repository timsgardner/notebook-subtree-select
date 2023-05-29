// The module 'vscode' contains the VS Code extensibility API
// TODO: consider using unified for the traversal and tree stuff
// TODO: replace marked with remark
import * as vscode from "vscode";
import * as marked from "marked";
import { getTraversalFunctions } from "./traversals";
import { mapGenerator, filterGenerator, isNonNullable, enforcePresence } from "./utils";
import {visit} from 'unist-util-visit';
import {remark} from 'remark';

const notebookSubtreeSelectCommandName =
  "notebook-subtree-select.notebookSubtreeSelect" as const;
const gotoParentCellName = "notebook-subtree-select.gotoParentCell" as const;
const gotoForwardAndUpCommandName =
  "notebook-subtree-select.gotoForwardAndUp" as const;
const gotoBackwardAndUpCommandName =
  "notebook-subtree-select.gotoBackwardAndUp" as const;
const gotoForwardAndOverCommandName =
  "notebook-subtree-select.gotoForwardAndOver" as const;
const gotoNextBreadthFirstCommandName =
  "notebook-subtree-select.gotoNextBreadthFirst" as const;
const gotoNextDepthFirstCommandName =
  "notebook-subtree-select.gotoNextDepthFirst" as const;
const insertHeadingBelowCommandName =
  "notebook-subtree-select.insertHeadingBelow" as const;

const cellTreeBrand = Symbol("IsCellTree");

type CellTreeBase = {
  [cellTreeBrand]: true;
  children: CellTreeBranch[];
};

type CellTreeRoot = CellTreeBase & {
  root: true;
};

type CellTreeBranch = CellTreeBase & {
  root: false;
  cell: vscode.NotebookCell;
  parent: CellTree;
};

type PreconnectedCellTreeBranch = Omit<
  CellTreeBranch,
  "parent" | "children"
> & { children: PreconnectedCellTreeBranch[] };

type CellTree = CellTreeRoot | CellTreeBranch;

function isCellTree(x: any): x is CellTree {
  return x && x[cellTreeBrand] === true;
}

/********************************
 * traversals
 *******************************/

const {
  backwardAndUpTraversal,
  breadthFirstTraversal,
  depthFirstTraversal,
  forwardAndOverTraversal,
  forwardAndUpTraversal,
} = getTraversalFunctions(
  (t: CellTree) => (t.root ? null : t.parent),
  (t: CellTree) => t.children
);

/********************************
 * markdown wrangling
 *******************************/

function makeMarkedInstance() {
  return marked.marked.setOptions({ mangle: false, headerIds: false });
}

function adjustHeadingLevels(markdown: string, change: number) {
  // Parse the markdown into an AST
  const ast = remark.parse(markdown);

  // Traverse the AST and adjust the heading levels
  visit(ast, 'heading', node => {
    node.depth = Math.max(1, Math.min(node.depth + change, 6)) as any;
  });

  // Serialize the AST back into a markdown string
  const newMarkdown = remark.stringify(ast);

  return newMarkdown;
}


/********************************
 * Parse notebook tree
 *******************************/

/**
 * Determines the concluding Markdown level of a given text starting from a specified Markdown level.
 *
 * @param text - The text to analyze.
 * @param startingMarkdownLevel - The starting Markdown level.
 * @returns The concluding Markdown level.
 */
function concludingMarkdownLevel(
  text: string,
  startingMarkdownLevel: number
): number {
  let headingLevel = startingMarkdownLevel;

  const walkTokens = (token: marked.marked.Token) => {
    if (token.type === "heading") {
      headingLevel = token.depth as number;
    }
  };

  const markedInstance = makeMarkedInstance();
  markedInstance.use({ walkTokens });
  markedInstance.parse(text);

  return headingLevel;
}

/**
 * Checks if the given notebook cell is a headline cell.
 *
 * @param cell - The notebook cell to check.
 * @returns A boolean indicating whether the cell is a headline cell.
 */
function isHeadlineCell(cell: vscode.NotebookCell): boolean {
  if (cell.kind !== vscode.NotebookCellKind.Markup) {
    return false;
  }

  const text = cell.document.getText();
  let isHeadline = false;

  const walkTokens = (token: marked.marked.Token) => {
    if (token.type === "heading") {
      isHeadline = true;
    }
  };

  const markedInstance = makeMarkedInstance();
  markedInstance.use({ walkTokens });
  markedInstance.parse(text);
  return isHeadline;
}

/**
 * Recursively add `parent` connections to a PreconnectedCellTreeBranch, thus converting it to a proper CellTreeBranch.
 *
 * @param root
 * @param tree
 * @returns
 */
function connectCellTree(
  root: CellTree,
  tree: PreconnectedCellTreeBranch
): CellTreeBranch {
  // For giggles, trying to do this in a "typesafe" way via legerdemain. Sort of a
  // dumb pseudo-functional trick, can remove later on the vanishingly remote chance
  // anyone has a notebook massive enough for the slight flutter of short-lived
  // allocation to make a snowball's difference in hell
  const tChildren = tree.children;
  const x: CellTreeBranch = Object.assign(tree, { parent: root, children: [] });
  const y: CellTreeBranch = Object.assign(x, {
    children: tChildren.map((child) => connectCellTree(x, child)),
  });
  return y;
}

/**
 * Returns the tree without the parent connections.
 * We add those in the next step in `parseCellTree`.
 * Makes the recursion a little less annoying.
 * 
 * @param cells - Array of NotebookCells to parse as a tree.
 * @param cellInx - Index of the current cell.
 * 
 * @returns Array containing the preconnected cell tree branch and the next index.
 */
function preconnectedCellTree(
  cells: vscode.NotebookCell[],
  cellInx: number
): [PreconnectedCellTreeBranch, number] {
  const parentCell = cells[cellInx];
  if (isHeadlineCell(parentCell)) {
    const parentCmdl = concludingMarkdownLevel(parentCell.document.getText(), 0);
    const children: PreconnectedCellTreeBranch[] = [];

    // Helper function to wrap up the constructed cell tree branch and index.
    const wrapup = (inx: number): [PreconnectedCellTreeBranch, number] => {
      const tree: PreconnectedCellTreeBranch = {
        [cellTreeBrand]: true,
        cell: parentCell,
        children,
        root: false,
      };
      return [tree, inx];
    };

    // Scans forward across cells recursively parsing
    // as PreconnectedCellTreeBranch. Jumps forward the number
    // of cells consumed by each deeper parse call.
    let i = cellInx + 1;
    while (i < cells.length) {
      const maybeChildCell = cells[i];
      if (isHeadlineCell(maybeChildCell)) {
        const cmdl = concludingMarkdownLevel(maybeChildCell.document.getText(), 0);
        if (parentCmdl < cmdl) {
          const [childTree, j] = preconnectedCellTree(cells, i);
          children.push(childTree);
          i = j;
        } else {
          return wrapup(i);
        }
      } else {
        const [childTree, j] = preconnectedCellTree(cells, i);
        children.push(childTree);
        i = j;
      }
    }
    return wrapup(i);
  } else {
    return [
      { [cellTreeBrand]: true, cell: parentCell, root: false, children: [] },
      cellInx + 1,
    ];
  }
}

function parseCellTree(notebook: vscode.NotebookEditor): CellTreeRoot {
  // Only cells containing headlines may have children.
  // The children of a cell is all cells after the current cell,
  // until either the end of the document is reached, or a headline
  // cell is encountered with concluding depth less than that of the
  // parent cell. In which case, this cell is not included in the children
  // of the parent cell.
  const cells = Array.from({ length: notebook.notebook.cellCount }, (_, i) =>
    notebook.notebook.cellAt(i)
  );
  const preconnectedCells: PreconnectedCellTreeBranch[] = [];
  let i = 0;
  while (i < cells.length) {
    const [pctb, j] = preconnectedCellTree(cells, i);
    preconnectedCells.push(pctb);
    i = j;
  }
  // more legerdemain
  const root: CellTreeRoot = {
    root: true,
    children: [],
    [cellTreeBrand]: true,
  };
  const childrenCells = preconnectedCells.map((pctb) =>
    connectCellTree(root, pctb)
  );
  root.children = childrenCells;
  return root;
}

/********************************
 * CellTree helpers
 *******************************/

function getCell(cellTree: CellTree): vscode.NotebookCell | null {
  if (cellTree.root) {
    return null;
  }
  return cellTree.cell;
}

function cellTreeCells(tree: CellTree): vscode.NotebookCell[] {
  return [
    ...filterGenerator(
      mapGenerator(depthFirstTraversal(tree), getCell),
      isNonNullable
    ),
  ];
}

function findCellTree(
  cell: vscode.NotebookCell,
  cellTree: CellTree
): CellTreeBranch | null {
  for (const t of depthFirstTraversal(cellTree)) {
    if (!t.root && t.cell === cell) {
      return t;
    }
  }
  return null;
}


function depthOfTreeNode(cellTree: CellTree): number {
  let d = -1;
  let t: CellTree | null = cellTree;
  while (t) {
    d++;
    t = getParent(t);
  }
  return d;
}

/**
 * Returns the provided notebook editor if available, or the active notebook editor.
 *
 * @param providedNotebook - Optional: The provided notebook editor. Nullable.
 * @returns The provided notebook editor, if available; otherwise, the active notebook editor. Returns null if neither is available.
 */
function providedOrActiveNotebook(
  providedNotebook?: vscode.NotebookEditor | null
): vscode.NotebookEditor | null {
  // Get the notebook editor to use
  let notebook2: vscode.NotebookEditor;

  if (providedNotebook == null) {
    // If no provided notebook editor, use the active notebook editor
    const nb = vscode.window.activeNotebookEditor;
    if (nb == null) {
      return null;
    }
    notebook2 = nb;
  } else {
    // Use the provided notebook editor
    notebook2 = providedNotebook;
  }

  return notebook2;
}

/**
 * Returns the CellTree object representing the hierarchical structure of notebook cells.
 * If a specific cell and notebook editor are provided, it finds the CellTree for that cell.
 * If no cell or notebook editor is provided, it uses the active notebook editor and the currently selected cell.
 *
 * Note that the entire hierarchy can be accessed from this CellTree object via the `parent` attribute.
 *
 * @param cell - Optional: The notebook cell to find the CellTree for.
 * @param notebook - Optional: The notebook editor containing the cell.
 * @returns The CellTree object representing the hierarchy starting at `cell`, or null if not found.
 */
function cellTree(
  cell?: vscode.NotebookCell | null,
  notebook?: vscode.NotebookEditor
): CellTreeBranch | null {
  // Get the notebook editor to use
  const notebook2 = providedOrActiveNotebook(notebook);
  if (notebook2 == null) {
    return null;
  }

  // Get the cell to find the CellTree for
  let cell2: vscode.NotebookCell;
  if (cell == null) {
    const selection = notebook2.selection;
    if (selection == null || selection.isEmpty) {
      return null;
    }
    cell2 = notebook2.notebook.cellAt(selection.start);
  } else {
    cell2 = cell;
  }

  // Parse the CellTree for the notebook
  const root = parseCellTree(notebook2);

  // Find the CellTree for the given cell
  return findCellTree(cell2, root);
}

/********************************
 * Misc
 *******************************/

/**
 * Resolves the input parameter to obtain the corresponding NotebookCell.
 *
 * @param cellOrIndex - The NotebookCell or its index to be resolved.
 * @param notebook - Optional: The notebook editor containing the cells.
 * @returns The resolved NotebookCell, or null if not found.
 */
function resolveNotebookCell(
  cellOrIndex: vscode.NotebookCell | number,
  notebook?: vscode.NotebookEditor | null
): vscode.NotebookCell | null {
  // If the input parameter is already a NotebookCell, return it
  if (typeof cellOrIndex !== "number") {
    return cellOrIndex;
  }

  // If the input parameter is an index, find the corresponding NotebookCell
  const notebook2 = providedOrActiveNotebook(notebook);
  if (notebook2 == null) {
    return null;
  }

  const index = cellOrIndex as number;
  if (index < 0 || index >= notebook2.notebook.cellCount) {
    return null;
  }

  return notebook2.notebook.cellAt(index);
}

/**
 * Sets the selection range in the provided notebook editor, including both the start and end cells.
 *
 * @param startCell - The start cell or its index of the selection range.
 * @param endCell - The end cell or its index of the selection range.
 * @param notebook - (Optional) The notebook editor in which to set the selection range. If not provided or null, the active notebook editor will be used.
 * @param reveal - (Optional) Whether the editor should reveal the selection. Default: true.
 * @throws Error if the notebook editor or the cells cannot be found.
 */
function setSelectionInclusiveCellRange(
  startCell: vscode.NotebookCell | number,
  endCell: vscode.NotebookCell | number,
  notebook?: vscode.NotebookEditor | null,
  reveal: boolean = true
): void {
  const notebook2 = providedOrActiveNotebook(notebook);
  if (notebook2 == null) {
    throw new Error("Cannot find notebook editor.");
  }
  const startCell2 = resolveNotebookCell(startCell, notebook2);
  const endCell2 = resolveNotebookCell(endCell, notebook2);
  if (startCell2 == null || endCell2 == null) {
    throw new Error("Cannot find cells.");
  }
  const range = new vscode.NotebookRange(startCell2.index, endCell2.index + 1);
  notebook2.selection = range;
  if (reveal) {
    notebook2.revealRange(range);
  }
}

function selectCellTree(cellTree: CellTree): void {
  const cells = cellTreeCells(cellTree);
  setSelectionInclusiveCellRange(cells[0].index, cells[cells.length - 1].index);
}

function stopEditingCell(): void {
  vscode.commands.executeCommand("notebook.cell.quitEdit");
}

/**
 * Returns the first selected cell in the provided notebook editor or the active notebook editor.
 *
 * @param notebook - Optional: The notebook editor to retrieve the selected cell from.
 * @returns The first selected cell, or null if no cell is selected or no notebook editor is available.
 */
function selectedCell(
  notebook?: vscode.NotebookEditor | null
): vscode.NotebookCell | null {
  // Get the notebook editor to use
  const notebook2 = providedOrActiveNotebook(notebook);
  if (notebook2 == null) {
    return null;
  }

  // Retrieve the first selected cell, if available
  const selection = notebook2.selection;
  if (selection !== undefined && !selection.isEmpty) {
    return notebook2.notebook.cellAt(selection.start);
  }

  // No cell is selected
  return null;
}

// TODO: make signature consistent with selectedCell
function selectedCells(): vscode.NotebookCell[] {
  const notebook = enforcePresence(providedOrActiveNotebook());
  const cells: vscode.NotebookCell[] = [];
  for (let i = notebook.selection.start; i < notebook.selection.end; i++) {
    cells.push(notebook.notebook.cellAt(i));
  }
  return cells;
}

/********************************
 * Selectors
 *******************************/

function selectSubtree(): void {
  const tree = cellTree(selectedCell());
  if (tree === null) {
    return;
  }
  selectCellTree(tree);
}

function selectSiblings(notebook: vscode.NotebookEditor): void {
  const tree = cellTree(selectedCell());
  if (tree === null) {
    return;
  }
  const p = tree.parent;
  setSelectionInclusiveCellRange(
    p.children[0].cell,
    tree.children[tree.children.length - 1].cell
  );
}

/********************************
 * gotos
 *******************************/

function gotoCell(
  cellOrTree: vscode.NotebookCell | CellTree | undefined | null
): void {
  if (cellOrTree != null) {
    let cell: vscode.NotebookCell;
    if (isCellTree(cellOrTree)) {
      if (cellOrTree.root) {
        return;
      }
      cell = cellOrTree.cell;
    } else {
      cell = cellOrTree;
    }
    setSelectionInclusiveCellRange(cell, cell);
  }
}

function getParent(t: CellTree | null): CellTree | null {
  if (t == null) {
    return null;
  }
  if (!t.root) {
    return t.parent;
  }
  return null;
}

function gotoParentCell(): void {
  gotoCell(getParent(cellTree(selectedCell())));
}

function gotoForwardAndUp(): void {
  const tree = cellTree(selectedCell());
  if (tree == null) {
    return;
  } 
  gotoCell(forwardAndUpTraversal(tree).next().value || null);
}

function gotoBackwardAndUp(): void {
  const tree = cellTree(selectedCell());
  if (tree === null) {
    return;
  }
  gotoCell(backwardAndUpTraversal(tree).next().value || null);
}

function gotoForwardAndOver(): void {
  const tree = cellTree(selectedCell());
  if (tree == null) {
    return;
  }
  gotoCell(forwardAndOverTraversal(tree).next().value || null);
}

function gotoNextBreadthFirst(): void {
  const tree = cellTree(selectedCell());
  if (tree == null) {
    return;
  }
  gotoCell(breadthFirstTraversal(tree).next().value || null);
}

function gotoNextDepthFirst(): void {
  const tree = cellTree(selectedCell());
  if (tree == null) {
    return;
  }
  gotoCell(depthFirstTraversal(tree).next().value || null);
}

/********************************
 * Edits
 *******************************/

async function insertMarkdownCell(position: number): Promise<vscode.NotebookCell> {
  const notebook = enforcePresence(providedOrActiveNotebook());
  await vscode.commands.executeCommand('notebook.cell.quitEdit');
  
  if (position === 0) {
    await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellAtTop');
  } else {
    const predecessorCell = notebook.notebook.cellAt(position - 1);
    notebook.selection = new vscode.NotebookRange(predecessorCell.index, predecessorCell.index + 1);
    await vscode.commands.executeCommand('notebook.cell.insertMarkdownCellBelow');
  }
  return notebook.notebook.cellAt(position);
}


/**
 * 
 * This one is buggy. Sometimes the headline `#`s don't get inserted, sometimes
 * they do. For whatever reason, once they start working they seem to keep working.
 * No idea.
 * @param position 
 */
async function insertHeadingAtIndex(position: number) {
  const notebook = enforcePresence(providedOrActiveNotebook());
  const cell = await insertMarkdownCell(position);
  const t = cellTree(cell, notebook)!;
  const depth = depthOfTreeNode(t);
  console.log(`depth: ${depth}`);
  notebook.selection = new vscode.NotebookRange(cell.index, cell.index + 1);
  // await vscode.commands.executeCommand('jupyter.selectCellContents');
  // await vscode.commands.executeCommand('jupyter.selectCell');
  await vscode.commands.executeCommand('notebook.cell.edit');
  const text = '#'.repeat(depth - 1) + ' '; 
  // console.log('text:', text);
  await vscode.commands.executeCommand('type', { text });
  // console.log('typed! hopefully');
}

async function insertHeadingBelow() {
  const cell = selectedCell();
  if (!cell) {
    return;
  }
  insertHeadingAtIndex(cell.index + 1);
}


/********************************
 * Activation
 *******************************/

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json

  // Define command-function pairs
  const commands = [
    [notebookSubtreeSelectCommandName, selectSubtree],
    [gotoParentCellName, gotoParentCell],
    [gotoForwardAndUpCommandName, gotoForwardAndUp],
    [gotoBackwardAndUpCommandName, gotoBackwardAndUp],
    [gotoForwardAndOverCommandName, gotoForwardAndOver],
    [gotoNextBreadthFirstCommandName, gotoNextBreadthFirst],
    [gotoNextDepthFirstCommandName, gotoNextDepthFirst],
    [insertHeadingBelowCommandName, insertHeadingBelow],
    ["notebook-subtree-select.incrementHeading", async () => {
      const notebook = vscode.window.activeNotebookEditor;
      if (!notebook) {
        vscode.window.showInformationMessage('No active notebook editor');
        return;
      }
      const cells = selectedCells().filter(isHeadlineCell);
      
      if (cells.length === 0) {
        return;
      }

      const edit = new vscode.WorkspaceEdit();

      for (const cell of cells) {
        const oldText = cell.document.getText();
        const newText = adjustHeadingLevels(oldText, 1);
        edit.replace(cell.document.uri, new vscode.Range(0, 0, cell.document.lineCount, 0), newText);
      }

      await vscode.workspace.applyEdit(edit);
      const firstCell = cells[0];
      setSelectionInclusiveCellRange(firstCell, firstCell, notebook, false);
      await vscode.commands.executeCommand('notebook.cell.edit');
      await vscode.commands.executeCommand('notebook.cell.quitEdit');
     
    }]
  ] as const;

  // Register each command
  for (const [commandName, commandFunc] of commands) {
    const disposable = vscode.commands.registerCommand(
      commandName,
      commandFunc
    );
    context.subscriptions.push(disposable);
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}
