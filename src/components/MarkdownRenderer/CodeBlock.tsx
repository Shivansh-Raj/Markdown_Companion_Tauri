import { useEffect, useState } from "react";
import { highlight } from "../../services/highlighter";
import { useTheme } from "../../services/themeContext";

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const theme = useTheme();
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlight(code, lang, theme)
      .then((h) => !cancelled && setHtml(h))
      .catch(() => !cancelled && setHtml(null));
    return () => {
      cancelled = true;
    };
  }, [code, lang, theme]);

  if (html) return <div className="code-block" dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
