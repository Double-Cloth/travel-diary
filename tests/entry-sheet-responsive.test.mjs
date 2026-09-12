import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const entrySheetCss = await readFile(new URL('../css/06-entry-sheet.css', import.meta.url), 'utf8');

test('移动端旅行详情为关闭按钮预留横向空间', () => {
    assert.match(
        entrySheetCss,
        /\.sheet-meta\s*{[^}]*padding-right:\s*40px;/
    );
});
