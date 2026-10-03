import { t, useLocale } from './i18n.ts';
import React, { useEffect, useRef, useState } from 'react';
import { EditorState, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import {
  baseKeymap,
  chainCommands,
  exitCode,
  setBlockType,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { splitListItem, sinkListItem, liftListItem, wrapInList } from 'prosemirror-schema-list';
import {
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  undoInputRule,
} from 'prosemirror-inputrules';
import 'prosemirror-view/style/prosemirror.css';
import { Icon } from './Marks.tsx';
import { documentSchema, writeDocument, type DocumentSource } from './document-markdown.ts';
import './document-editor.css';

export interface DocumentMemory {
  state: EditorState;
  source: DocumentSource;
  text: string;
}

function initialState(source: DocumentSource): EditorState {
  const { nodes, marks } = documentSchema;
  return EditorState.create({
    doc: source.doc,
    plugins: [
      history(),
      inputRules({
        rules: [
          textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading, (match) => ({
            level: match[1].length,
          })),
          wrappingInputRule(/^>\s$/, nodes.blockquote),
          wrappingInputRule(/^[-+*]\s$/, nodes.bullet_list),
        ],
      }),
      keymap({
        'Mod-z': undo,
        'Mod-Shift-z': redo,
        'Mod-y': redo,
        'Mod-b': toggleMark(marks.strong),
        'Mod-i': toggleMark(marks.em),
        'Mod-`': toggleMark(marks.code),
        Enter: splitListItem(nodes.list_item),
        Tab: sinkListItem(nodes.list_item),
        'Shift-Tab': liftListItem(nodes.list_item),
        Backspace: chainCommands(undoInputRule, baseKeymap.Backspace),
        'Mod-Enter': exitCode,
      }),
      keymap(baseKeymap),
    ],
  });
}

export function DocumentEditor({
  source,
  text,
  memory,
  readonly,
  onChange,
}: {
  source: DocumentSource;
  text: string;
  memory?: DocumentMemory;
  readonly: boolean;
  onChange: (text: string, memory: DocumentMemory) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const locale = useLocale();
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const locked = useRef(readonly);
  const [selectionLength, setSelectionLength] = useState(0);
  const [state, setState] = useState<EditorState | null>(null);
  callback.current = onChange;
  locked.current = readonly;
  useEffect(() => {
    if (!mount.current) return;
    const baseline = memory?.source ?? source;
    let latestText = memory?.text ?? source.text;
    const editor = new EditorView(mount.current, {
      state: memory?.state ?? initialState(source),
      attributes: {
        role: 'textbox',
        'aria-label': t('文档内容'),
        'aria-multiline': 'true',
        spellcheck: 'false',
      },
      editable: () => !locked.current,
      handleClick: (_view, _position, event) => !!(event.target as Element).closest('a'),
      handleDOMEvents: {
        click: (_view, event) => {
          if ((event.target as Element).closest('a')) {
            event.preventDefault();
            return true;
          }
          return false;
        },
      },
      dispatchTransaction: (transaction) => {
        if (locked.current && transaction.docChanged) return;
        const next = editor.state.apply(transaction);
        editor.updateState(next);
        setState(next);
        setSelectionLength(
          next.doc.textBetween(next.selection.from, next.selection.to, '\n').length,
        );
        const text = transaction.docChanged ? writeDocument(baseline, next.doc) : latestText;
        // Keep selection and undo history with this file tab, including across mode switches.
        latestText = text;
        callback.current(text, { source: baseline, state: next, text });
      },
    });
    view.current = editor;
    setState(editor.state);
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => {
    view.current?.setProps({ editable: () => !readonly });
  }, [readonly]);
  useEffect(() => {
    view.current?.dom.setAttribute('aria-label', t('文档内容'));
  }, [locale]);
  const run = (command: Command) => {
    const editor = view.current;
    if (!editor || readonly) return;
    command(editor.state, editor.dispatch, editor);
    editor.focus();
  };
  const { nodes, marks } = documentSchema;
  const tools: { label: string; mark?: string; icon?: string; text?: string; command: Command }[] =
    [
      { label: t('撤销'), icon: 'back', command: undo },
      { label: t('重做'), icon: 'arrow', command: redo },
      { label: t('加粗'), mark: 'strong', text: 'B', command: toggleMark(marks.strong) },
      { label: t('斜体'), mark: 'em', text: 'I', command: toggleMark(marks.em) },
      { label: t('二级标题'), text: 'H2', command: setBlockType(nodes.heading, { level: 2 }) },
      { label: t('正文'), text: '¶', command: setBlockType(nodes.paragraph) },
      { label: t('项目列表'), text: '•', command: wrapInList(nodes.bullet_list) },
      { label: t('引用段落'), text: '❞', command: wrapIn(nodes.blockquote) },
      { label: t('代码块'), text: '</>', command: setBlockType(nodes.code_block) },
    ];
  return (
    <div className="document-editing">
      <div className="document-formatting" role="toolbar" aria-label={t('文档格式')}>
        {tools.map((tool) => (
          <button
            type="button"
            key={tool.label}
            aria-label={tool.label}
            title={tool.label}
            aria-pressed={
              tool.mark && state
                ? state.selection.empty
                  ? !!marks[tool.mark].isInSet(state.storedMarks ?? state.selection.$from.marks())
                  : state.doc.rangeHasMark(
                      state.selection.from,
                      state.selection.to,
                      marks[tool.mark],
                    )
                : undefined
            }
            disabled={readonly || !state || !tool.command(state)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(tool.command)}
          >
            {tool.icon ? <Icon name={tool.icon} size={14} /> : tool.text}
          </button>
        ))}
      </div>
      <div className="document-canvas" ref={mount} />
      <div className="document-count" aria-live="off">
        {t('选中')}
        {selectionLength} {t('字 · 共')}
        {text.length} {t('字')}
      </div>
    </div>
  );
}
