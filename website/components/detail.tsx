"use client";

import { type ReactNode, useState, useRef, useEffect } from "react";

/** Inline detail tooltip for table cells. Renders children with a dotted underline;
 *  hover/tap reveals the `t` (tip) text in a popover. */
export function D({ children, t }: { children: ReactNode; t: string }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
		function close(e: MouseEvent | TouchEvent) {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		}
		document.addEventListener("mousedown", close);
		document.addEventListener("touchstart", close);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("touchstart", close);
		};
	}, [open]);

	return (
		<span
			ref={ref}
			className="relative cursor-help"
			onMouseEnter={() => setOpen(true)}
			onMouseLeave={() => setOpen(false)}
			onClick={() => setOpen((v) => !v)}
		>
			<span className="decoration-dotted decoration-fd-muted-foreground/40 underline underline-offset-2">
				{children}
			</span>
			{open && (
				<span className="absolute bottom-full left-0 z-50 mb-1.5 w-max max-w-64 rounded-md border border-fd-border bg-fd-popover px-2.5 py-1.5 text-xs text-fd-popover-foreground shadow-md">
					{t}
				</span>
			)}
		</span>
	);
}
