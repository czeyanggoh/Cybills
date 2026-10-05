import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchMailBody } from '@/lib/mailbox';
import { mailFrameDoc, MAIL_FRAME_SANDBOX } from '@/lib/mailHtml';
import { cn } from '@/lib/utils';

// A mail's body, as it was sent.
//
// The plain-text part of an order confirmation is a flattened copy of it: the
// table a run of lines, every link written out in angle brackets. So where the
// HTML part was kept, that is what is drawn — in a frame that can run nothing
// (see mailHtml.js) — with the text one click away, since the text is what the
// reader was given and what a covering note is quoted from.
//
// `lazy` waits to be asked: a thread of forty messages must not fetch forty
// bodies to draw a list.
export default function MailBody({ billId, messageId, text, lazy = false, maxHeight, textClassName, empty = null }) {
  const [html, setHtml] = useState('');
  const [asked, setAsked] = useState(!lazy);
  const [plain, setPlain] = useState(false);
  const [height, setHeight] = useState(240);
  const frame = useRef(null);

  useEffect(() => {
    if (!asked) return undefined;
    let live = true;
    setHtml('');
    fetchMailBody({ billId, messageId })
      .then((body) => live && setHtml(body))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [asked, billId, messageId]);

  const srcDoc = useMemo(() => (html ? mailFrameDoc(html) : ''), [html]);
  const formatted = Boolean(srcDoc) && !plain;

  const measure = () => {
    const doc = frame.current?.contentDocument;
    if (doc?.documentElement) setHeight(Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0) + 2);
  };

  const toggle = 'mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground';
  return (
    <div>
      {formatted ? (
        <div className="overflow-auto rounded-md border bg-white" style={maxHeight ? { maxHeight } : undefined}>
          <iframe
            ref={frame}
            title="Email message"
            sandbox={MAIL_FRAME_SANDBOX}
            srcDoc={srcDoc}
            onLoad={measure}
            className="block w-full border-0"
            style={{ height }}
          />
        </div>
      ) : text ? (
        <p className={cn('whitespace-pre-wrap text-muted-foreground', textClassName)}>{text}</p>
      ) : (
        empty
      )}
      {lazy && !asked ? (
        <button type="button" onClick={() => setAsked(true)} className={toggle}>
          Show as sent
        </button>
      ) : (
        srcDoc && (
          <button type="button" onClick={() => setPlain((p) => !p)} className={toggle}>
            {plain ? 'Show as sent' : 'Show plain text'}
          </button>
        )
      )}
    </div>
  );
}
