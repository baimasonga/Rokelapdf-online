// Every tool on the site: its URL, how it is described (also used for search engines), what it accepts, and whether
// it runs as a one-step tool page or opens the editor with a tool selected.

export type ToolGroup = 'organize' | 'edit' | 'sign' | 'convert';
export type ToolSlug =
  | 'merge-pdf'
  | 'split-pdf'
  | 'delete-pages'
  | 'extract-pages'
  | 'rotate-pdf'
  | 'organize-pdf'
  | 'add-pages'
  | 'crop-pdf'
  | 'edit-pdf'
  | 'highlight-pdf'
  | 'annotate-pdf'
  | 'watermark-pdf'
  | 'page-numbers'
  | 'flatten-pdf'
  | 'sign-pdf'
  | 'fill-pdf-form'
  | 'create-fillable-pdf'
  | 'pdf-to-jpg'
  | 'pdf-to-png'
  | 'jpg-to-pdf';

export interface ToolDef {
  slug: ToolSlug;
  title: string;
  /** One line under the title on cards. */
  short: string;
  /** Page description (also the meta description). */
  description: string;
  group: ToolGroup;
  icon: string; // lucide icon name, resolved in the UI
  /** The tool's own colour (icon tile background); white icons must stay legible on it. */
  color: string;
  accept: 'pdf' | 'image';
  multiple: boolean;
  /** Tools that work interactively open the editor with this tool selected. */
  editorTool?: 'select' | 'text' | 'highlight' | 'rect' | 'ink' | 'signature' | 'field';
  popular?: boolean;
}

export const GROUPS: Array<{ id: ToolGroup; title: string; blurb: string }> = [
  { id: 'organize', title: 'Organize', blurb: 'Merge, split, reorder and tidy up pages.' },
  { id: 'edit', title: 'Edit & annotate', blurb: 'Add text, highlights, watermarks and page numbers.' },
  { id: 'sign', title: 'Sign & forms', blurb: 'Sign documents and fill or create forms.' },
  { id: 'convert', title: 'Convert images', blurb: 'Turn PDFs into images and images into PDFs.' },
];

export const TOOLS: ToolDef[] = [
  {
    slug: 'merge-pdf',
    color: '#ef4444',
    title: 'Merge PDF',
    short: 'Combine several PDFs into one, in the order you choose.',
    description: 'Combine multiple PDF files into one document in your browser. Drag to reorder, then download — files never leave your device.',
    group: 'organize',
    icon: 'Combine',
    accept: 'pdf',
    multiple: true,
    popular: true,
  },
  {
    slug: 'split-pdf',
    color: '#f97316',
    title: 'Split PDF',
    short: 'Split by page ranges, every few pages, or into single pages.',
    description: 'Split a PDF into several files by page ranges, every N pages, or one file per page. Free, private, in your browser.',
    group: 'organize',
    icon: 'Scissors',
    accept: 'pdf',
    multiple: false,
    popular: true,
  },
  {
    slug: 'delete-pages',
    color: '#e11d48',
    title: 'Delete PDF pages',
    short: 'Remove the pages you don’t need.',
    description: 'Delete pages from a PDF: click the pages to remove or type page ranges, then download the result.',
    group: 'organize',
    icon: 'Trash2',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'extract-pages',
    color: '#0ea5e9',
    title: 'Extract pages',
    short: 'Save selected pages as a new PDF.',
    description: 'Pick pages from a PDF and save them as a new document, without changing the original.',
    group: 'organize',
    icon: 'FileOutput',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'rotate-pdf',
    color: '#8b5cf6',
    title: 'Rotate PDF',
    short: 'Turn all pages or just the ones you pick.',
    description: 'Rotate PDF pages 90°, 180° or 270° — the whole document or selected pages — and save it permanently.',
    group: 'organize',
    icon: 'RotateCw',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'organize-pdf',
    color: '#f59e0b',
    title: 'Organize pages',
    short: 'Reorder, rotate and delete pages visually.',
    description: 'Rearrange PDF pages with thumbnails: move, rotate, delete and insert pages, then save.',
    group: 'organize',
    icon: 'LayoutGrid',
    accept: 'pdf',
    multiple: false,
    editorTool: 'select',
  },
  {
    slug: 'add-pages',
    color: '#14b8a6',
    title: 'Add pages',
    short: 'Insert blank pages or another PDF anywhere.',
    description: 'Insert blank pages or the pages of another PDF at any position in your document.',
    group: 'organize',
    icon: 'FilePlus',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'crop-pdf',
    color: '#22c55e',
    title: 'Crop PDF',
    short: 'Trim margins from every page or selected pages.',
    description: 'Crop PDF pages by trimming margins — set how much to cut from each side and apply it to all or selected pages.',
    group: 'organize',
    icon: 'Crop',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'edit-pdf',
    color: '#2563eb',
    title: 'Edit PDF',
    short: 'Add text, boxes and drawings to any page.',
    description: 'Edit PDFs online for free: add text, shapes, freehand drawing and whiteout, rotate and reorder pages.',
    group: 'edit',
    icon: 'FilePen',
    accept: 'pdf',
    multiple: false,
    editorTool: 'text',
    popular: true,
  },
  {
    slug: 'highlight-pdf',
    color: '#d97706',
    title: 'Highlight PDF',
    short: 'Highlight important passages.',
    description: 'Highlight text and areas in a PDF in your browser, then download or share it.',
    group: 'edit',
    icon: 'Highlighter',
    accept: 'pdf',
    multiple: false,
    editorTool: 'highlight',
  },
  {
    slug: 'annotate-pdf',
    color: '#db2777',
    title: 'Annotate PDF',
    short: 'Comment with text, boxes and freehand notes.',
    description: 'Annotate a PDF with notes, boxes and freehand drawing, then download or send it for review.',
    group: 'edit',
    icon: 'MessageSquareText',
    accept: 'pdf',
    multiple: false,
    editorTool: 'ink',
  },
  {
    slug: 'watermark-pdf',
    color: '#0891b2',
    title: 'Add watermark',
    short: 'Stamp text like “CONFIDENTIAL” on every page.',
    description: 'Add a text watermark to a PDF — diagonal, centred or tiled, with your colour and transparency.',
    group: 'edit',
    icon: 'Stamp',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'page-numbers',
    color: '#4f46e5',
    title: 'Add page numbers',
    short: 'Number pages in any corner, in your format.',
    description: 'Add page numbers to a PDF: choose the position, format (“Page 1 of 9”), starting number, and skip the cover.',
    group: 'edit',
    icon: 'ListOrdered',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'flatten-pdf',
    color: '#64748b',
    title: 'Flatten PDF',
    short: 'Lock form fields into the page.',
    description: 'Flatten a PDF so filled-in form fields become part of the page and look the same everywhere.',
    group: 'edit',
    icon: 'Layers',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'sign-pdf',
    color: '#7c3aed',
    title: 'Sign PDF',
    short: 'Draw, type or upload your signature.',
    description: 'Sign a PDF online: draw, type or upload a signature, place it on the page and download — no account needed.',
    group: 'sign',
    icon: 'Signature',
    accept: 'pdf',
    multiple: false,
    editorTool: 'signature',
    popular: true,
  },
  {
    slug: 'fill-pdf-form',
    color: '#059669',
    title: 'Fill out PDF form',
    short: 'Type into a PDF’s form fields.',
    description: 'Fill out fillable PDF forms in your browser — text fields, checkboxes and drop-downs — and optionally lock the answers.',
    group: 'sign',
    icon: 'ClipboardList',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'create-fillable-pdf',
    color: '#0d9488',
    title: 'Create fillable PDF',
    short: 'Add text fields and checkboxes to a PDF.',
    description: 'Turn any PDF into a fillable form by drawing text fields and checkboxes on the page.',
    group: 'sign',
    icon: 'FormInput',
    accept: 'pdf',
    multiple: false,
    editorTool: 'field',
  },
  {
    slug: 'pdf-to-jpg',
    color: '#ea580c',
    title: 'PDF to JPG',
    short: 'Save each page as a JPG image.',
    description: 'Convert PDF pages to high-quality JPG images in your browser and download them as a ZIP.',
    group: 'convert',
    icon: 'FileImage',
    accept: 'pdf',
    multiple: false,
    popular: true,
  },
  {
    slug: 'pdf-to-png',
    color: '#0284c7',
    title: 'PDF to PNG',
    short: 'Save each page as a sharp PNG image.',
    description: 'Convert PDF pages to PNG images with lossless quality and download them as a ZIP.',
    group: 'convert',
    icon: 'Image',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'jpg-to-pdf',
    color: '#16a34a',
    title: 'JPG to PDF',
    short: 'Turn photos and scans into a PDF.',
    description: 'Convert JPG, PNG and WebP images to a PDF — one page per image, fitted or on A4/Letter pages.',
    group: 'convert',
    icon: 'Images',
    accept: 'image',
    multiple: true,
    popular: true,
  },
];

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);
