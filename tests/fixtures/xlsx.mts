// A spreadsheet written as Excel writes one, the least of it: an .xlsx is a zip of XML, with text in a table of shared
// strings that cells name by number, and numbers in the cells themselves, each cell placed by its reference ("C2").
// For the finals' sheet (tests/fixtures/finals.mts) and the tests reading sheets as scripts/map/finals.mts does

import { strToU8, zipSync } from "fflate"
import type { Cell } from "../../src/courses/finals.mts"

const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The column a number from 0 is: 0 is A, 26 is AA */
const letters = (column: number): string =>
  (column >= 26 ? letters(Math.floor(column / 26) - 1) : "") + String.fromCharCode(65 + column % 26)

/** An .xlsx of one sheet of rows, a cell left empty where there's nothing */
export const xlsxOf = (rows: readonly (readonly Cell[])[], sheet = "Sheet1") => {
  const strings: string[] = []
  const indexOf = new Map<string, number>()
  const shared = (text: string) =>
    indexOf.get(text) ?? (indexOf.set(text, strings.push(text) - 1), strings.length - 1)
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) =>
    cell === undefined ? "" :
    typeof cell === "number" ? `<c r="${letters(c)}${r + 1}"><v>${cell}</v></c>` :
                               `<c r="${letters(c)}${r + 1}" t="s"><v>${shared(cell)}</v></c>`
  ).join("")}</row>`).join("")
  const xml = (text: string) => strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${text}`)
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  return zipSync({
    "[Content_Types].xml": xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`),
    "_rels/.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": xml(`<workbook xmlns="${main}" xmlns:r="${relationships}"><sheets><sheet name="${escaped(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationships}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": xml(`<worksheet xmlns="${main}"><sheetData>${body}</sheetData></worksheet>`),
    "xl/sharedStrings.xml": xml(`<sst xmlns="${main}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(text => `<si><t xml:space="preserve">${escaped(text)}</t></si>`).join("")}</sst>`)
  })
}
