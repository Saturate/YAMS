import defaultMdxComponents from "fumadocs-ui/mdx";
import { D } from "@/components/detail";
import {
	DocsBody,
	DocsDescription,
	DocsPage,
	DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";
import { source } from "@/lib/source";

// fumadocs-mdx v11 loses body/toc/full types when files pass through loader,
// but the runtime data is correct
interface MdxPageData {
	title: string;
	description?: string;
	body: React.FC<{ components: Record<string, React.ComponentType<never>> }>;
	toc: Array<{ title: string; url: string; depth: number }>;
	full?: boolean;
}

export default async function Page(props: {
	params: Promise<{ slug?: string[] }>;
}) {
	const params = await props.params;
	const page = source.getPage(params.slug);
	if (!page) notFound();

	const data = page.data as unknown as MdxPageData;
	const MDX = data.body;

	return (
		<DocsPage toc={data.toc} full={data.full}>
			<DocsTitle>{data.title}</DocsTitle>
			<DocsDescription>{data.description}</DocsDescription>
			<DocsBody>
				<MDX components={{ ...defaultMdxComponents, D }} />
			</DocsBody>
		</DocsPage>
	);
}

export async function generateStaticParams() {
	return source.generateParams();
}

export async function generateMetadata(props: {
	params: Promise<{ slug?: string[] }>;
}) {
	const params = await props.params;
	const page = source.getPage(params.slug);
	if (!page) notFound();

	return {
		title: page.data.title,
		description: page.data.description,
	};
}
