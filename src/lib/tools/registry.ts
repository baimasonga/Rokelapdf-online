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
  | 'compress-pdf'
  | 'redact-pdf'
  | 'edit-pdf'
  | 'highlight-pdf'
  | 'annotate-pdf'
  | 'watermark-pdf'
  | 'page-numbers'
  | 'flatten-pdf'
  | 'sign-pdf'
  | 'fill-pdf-form'
  | 'create-fillable-pdf'
  | 'protect-pdf'
  | 'unlock-pdf'
  | 'pdf-to-jpg'
  | 'pdf-to-png'
  | 'jpg-to-pdf'
  | 'ocr-pdf'
  | 'pdf-to-word'
  | 'pdf-to-excel'
  | 'pdf-to-powerpoint'
  | 'word-to-pdf'
  | 'excel-to-pdf'
  | 'powerpoint-to-pdf';

/** What a tool takes as input. Office kinds name the file extensions they accept. */
export type ToolInput = 'pdf' | 'image' | 'word' | 'excel' | 'powerpoint';
export const OFFICE_INPUTS: Record<'word' | 'excel' | 'powerpoint', string[]> = {
  word: ['docx', 'doc', 'odt', 'rtf'],
  excel: ['xlsx', 'xls', 'ods'],
  powerpoint: ['pptx', 'ppt', 'odp'],
};

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
  accept: ToolInput;
  multiple: boolean;
  /** Tools that work interactively open the editor with this tool selected. */
  editorTool?: 'redact' | 'select' | 'text' | 'highlight' | 'rect' | 'ink' | 'signature' | 'field';
  /** Can run on many PDFs at once (same settings for each, results as a ZIP). */
  batch?: boolean;
  popular?: boolean;
  /**
   * Converted on the server (LibreOffice and layout analysis cannot run in a browser): signed-in users only, the file
   * is sent to the converter and the result returned straight away — nothing is stored.
   */
  server?: { target: 'docx' | 'xlsx' | 'pptx' | 'pdf' };
}

export const GROUPS: Array<{ id: ToolGroup; title: string; blurb: string }> = [
  { id: 'organize', title: 'Organize & optimize', blurb: 'Merge, split, compress, reorder and tidy up pages.' },
  { id: 'edit', title: 'Edit & annotate', blurb: 'Add text, highlights, watermarks and page numbers.' },
  { id: 'sign', title: 'Sign, forms & security', blurb: 'Sign documents, fill or create forms, add or remove passwords.' },
  { id: 'convert', title: 'Convert & OCR', blurb: 'PDF to Word, Excel, PowerPoint and images — and back — plus searchable text from scans.' },
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
    batch: true,
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
    description: 'Rearrange PDF pages visually: drag to reorder, rotate, delete, add blank pages or pages from other PDFs, then download.',
    group: 'organize',
    icon: 'LayoutGrid',
    accept: 'pdf',
    multiple: false,
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
    batch: true,
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
    slug: 'compress-pdf',
    batch: true,
    color: '#65a30d',
    title: 'Compress PDF',
    short: 'Make a PDF smaller while keeping text sharp.',
    description: 'Reduce PDF file size in your browser: photos and scans are made lighter, text stays sharp and selectable. Nothing is uploaded.',
    group: 'organize',
    icon: 'Shrink',
    accept: 'pdf',
    multiple: false,
    popular: true,
  },
  {
    slug: 'redact-pdf',
    title: 'Redact PDF',
    short: 'Permanently remove sensitive content.',
    description:
      'Mark sensitive areas and export a new image-only PDF. Covered text, original content streams and interactive form fields are removed from the exported file.',
    color: '#111827',
    group: 'edit',
    icon: 'Eraser',
    accept: 'pdf',
    multiple: false,
    editorTool: 'redact',
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
    batch: true,
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
    batch: true,
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
    batch: true,
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
    slug: 'protect-pdf',
    batch: true,
    color: '#0f172a',
    title: 'Protect PDF',
    short: 'Add a password and choose what readers may do.',
    description: 'Password-protect a PDF with AES-256 encryption and optionally block printing, copying or editing. Done in your browser.',
    group: 'sign',
    icon: 'Lock',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'unlock-pdf',
    color: '#475569',
    title: 'Unlock PDF',
    short: 'Remove the password from a PDF you can open.',
    description: 'Remove password protection from a PDF when you know its password, so it opens without one. Done in your browser.',
    group: 'sign',
    icon: 'LockOpen',
    accept: 'pdf',
    multiple: false,
  },
  {
    slug: 'pdf-to-word',
    color: '#1d4ed8',
    title: 'PDF to Word',
    short: 'Turn a PDF into an editable Word document.',
    description:
      'Convert PDF to an editable Word (DOCX) document — paragraphs, fonts, tables and pictures are rebuilt so you can edit the text. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'FileText',
    accept: 'pdf',
    multiple: false,
    popular: true,
    server: { target: 'docx' },
  },
  {
    slug: 'pdf-to-excel',
    color: '#15803d',
    title: 'PDF to Excel',
    short: 'Pull tables out of a PDF into a spreadsheet.',
    description:
      'Convert PDF tables to an Excel (XLSX) spreadsheet with one sheet per page and numbers as real numbers. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'FileSpreadsheet',
    accept: 'pdf',
    multiple: false,
    server: { target: 'xlsx' },
  },
  {
    slug: 'pdf-to-powerpoint',
    color: '#c2410c',
    title: 'PDF to PowerPoint',
    short: 'Make a slide deck from a PDF, one slide per page.',
    description:
      'Convert a PDF to a PowerPoint (PPTX) presentation — every page becomes a sharp slide, with its text in the slide notes. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'Presentation',
    accept: 'pdf',
    multiple: false,
    server: { target: 'pptx' },
  },
  {
    slug: 'word-to-pdf',
    color: '#2563eb',
    title: 'Word to PDF',
    short: 'Convert DOCX and DOC documents to PDF.',
    description: 'Convert Word documents (DOCX, DOC, ODT, RTF) to PDF with the layout kept. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'FileType',
    accept: 'word',
    multiple: false,
    popular: true,
    server: { target: 'pdf' },
  },
  {
    slug: 'excel-to-pdf',
    color: '#059669',
    title: 'Excel to PDF',
    short: 'Convert spreadsheets to PDF.',
    description: 'Convert Excel spreadsheets (XLSX, XLS, ODS) to PDF, every sheet included. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'Sheet',
    accept: 'excel',
    multiple: false,
    server: { target: 'pdf' },
  },
  {
    slug: 'powerpoint-to-pdf',
    color: '#ea580c',
    title: 'PowerPoint to PDF',
    short: 'Convert presentations to PDF.',
    description:
      'Convert PowerPoint presentations (PPTX, PPT, ODP) to PDF, one page per slide. Free with an account; files are deleted right after converting.',
    group: 'convert',
    icon: 'FileDown',
    accept: 'powerpoint',
    multiple: false,
    server: { target: 'pdf' },
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
    slug: 'ocr-pdf',
    color: '#9333ea',
    title: 'OCR PDF',
    short: 'Make scanned PDFs searchable and copyable.',
    description:
      'Recognise the text in scanned PDFs and add it as an invisible, searchable layer — the pages look the same. English, in your browser; nothing is uploaded.',
    group: 'convert',
    icon: 'ScanText',
    accept: 'pdf',
    multiple: false,
    popular: true,
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
