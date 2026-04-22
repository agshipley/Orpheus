import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
} from "docx";
import type { ResumeStructured, CoverLetterStructured } from "../types.js";

const FONT = "Calibri";
const BODY_SIZE = 22; // half-points = 11pt
const SMALL_SIZE = 20; // 10pt
const NAME_SIZE = 36; // 18pt

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: text.toUpperCase(), bold: true, size: SMALL_SIZE, font: FONT })],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    border: { bottom: { color: "000000", space: 1, style: BorderStyle.SINGLE, size: 6 } },
  });
}

function bodyParagraph(text: string, opts: { bold?: boolean; italic?: boolean; indent?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italic, size: BODY_SIZE, font: FONT })],
    spacing: { after: 60 },
    indent: opts.indent ? { left: 360 } : undefined,
  });
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, size: BODY_SIZE, font: FONT })],
    bullet: { level: 0 },
    spacing: { after: 40 },
  });
}

function spacer(): Paragraph {
  return new Paragraph({ children: [new TextRun({ text: "", size: BODY_SIZE, font: FONT })], spacing: { after: 80 } });
}

function twoColumnLine(left: string, right: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: left, bold: true, size: BODY_SIZE, font: FONT }),
      new TextRun({ text: "\t" + right, size: SMALL_SIZE, font: FONT, color: "555555" }),
    ],
    tabStops: [{ type: "right" as const, position: 9000 }],
    spacing: { after: 40 },
  });
}

export async function renderResumeDocx(s: ResumeStructured): Promise<Buffer> {
  const children: Paragraph[] = [];

  // Name
  children.push(new Paragraph({
    children: [new TextRun({ text: s.header.name, bold: true, size: NAME_SIZE, font: FONT })],
    alignment: AlignmentType.CENTER,
    spacing: { after: 80 },
  }));

  // Contact line
  const contactParts = [
    s.header.email,
    s.header.phone,
    s.header.location,
    s.header.linkedin,
    s.header.github,
    s.header.website,
  ].filter(Boolean);

  if (contactParts.length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: contactParts.join("  ·  "), size: SMALL_SIZE, font: FONT, color: "444444" })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
    }));
  }

  // Summary
  children.push(sectionHeading("Summary"));
  children.push(bodyParagraph(s.summary));

  // Experience
  children.push(sectionHeading("Experience"));
  for (const exp of s.experience) {
    children.push(twoColumnLine(`${exp.role}  ·  ${exp.company}${exp.location ? "  ·  " + exp.location : ""}`, exp.dates));
    for (const bullet of exp.bullets) {
      children.push(bulletParagraph(bullet));
    }
    children.push(spacer());
  }

  // Education
  children.push(sectionHeading("Education"));
  for (const edu of s.education) {
    children.push(twoColumnLine(edu.degree, edu.dates));
    children.push(bodyParagraph(edu.institution, { italic: true }));
    for (const honor of edu.honors ?? []) {
      children.push(bulletParagraph(honor));
    }
    children.push(spacer());
  }

  // Projects
  if (s.selected_projects?.length) {
    children.push(sectionHeading("Selected Projects"));
    for (const proj of s.selected_projects) {
      children.push(bodyParagraph(proj.name, { bold: true }));
      children.push(bodyParagraph(proj.summary, { italic: true }));
      for (const bullet of proj.bullets) {
        children.push(bulletParagraph(bullet));
      }
      children.push(spacer());
    }
  }

  // Publications
  if (s.publications?.length) {
    children.push(sectionHeading("Publications"));
    for (const pub of s.publications) {
      children.push(bodyParagraph(pub.citation));
    }
  }

  // Skills
  if (s.skills?.length) {
    children.push(sectionHeading("Skills"));
    children.push(bodyParagraph(s.skills.join("  ·  ")));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

export async function renderCoverLetterDocx(s: CoverLetterStructured): Promise<Buffer> {
  const children: Paragraph[] = [];

  // Sender block
  children.push(bodyParagraph(s.sender.name, { bold: true }));
  children.push(bodyParagraph(s.sender.email));
  if (s.sender.location) children.push(bodyParagraph(s.sender.location));
  children.push(spacer());

  // Date
  children.push(bodyParagraph(s.date));
  children.push(spacer());

  // Recipient block
  if (s.recipient) {
    if (s.recipient.name) {
      const nameTitle = [s.recipient.name, s.recipient.title].filter(Boolean).join(", ");
      children.push(bodyParagraph(nameTitle));
    }
    children.push(bodyParagraph(s.recipient.company));
    if (s.recipient.address) children.push(bodyParagraph(s.recipient.address));
    children.push(spacer());
  }

  // Salutation
  children.push(bodyParagraph(s.salutation));
  children.push(spacer());

  // Body paragraphs
  for (const para of s.paragraphs) {
    children.push(bodyParagraph(para));
    children.push(spacer());
  }

  // Closing
  children.push(bodyParagraph(s.closing));
  children.push(spacer());
  children.push(spacer());
  children.push(bodyParagraph(s.signature, { bold: true }));

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT, size: BODY_SIZE },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").slice(0, 50);
}

// PKZIP magic bytes check for tests
export function isDocxBuffer(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
}

// Re-export HeadingLevel so the heading-1 reference below compiles cleanly
export { HeadingLevel };
