import type { Meta, StoryObj } from '@storybook/react';
import { WebTool } from '../components/tools/WebTool';

const meta: Meta<typeof WebTool> = {
  title: 'Tools/WebTool',
  component: WebTool,
};

export default meta;
type Story = StoryObj<typeof WebTool>;

export const SearchWithLinks: Story = {
  args: {
    input: { query: 'react server components tutorial' },
    result: `Links: [{"title":"Understanding React Server Components","url":"https://react.dev/blog/2023/03/22/react-labs-march-2023"},{"title":"Next.js App Router - Server Components","url":"https://nextjs.org/docs/app/building-your-application/rendering/server-components"},{"title":"A Deep Dive into RSC","url":"https://www.joshwcomeau.com/react/server-components/"}]
Server components allow rendering on the server without sending JavaScript to the client. They can access databases directly and reduce bundle size significantly.`,
    toolType: 'WebSearch',
  },
};

export const SearchNoLinks: Story = {
  args: {
    input: { query: 'obscure query with no structured results' },
    result: 'No relevant results found for this query. Try rephrasing or using different keywords.',
    toolType: 'WebSearch',
  },
};

export const FetchWithContent: Story = {
  args: {
    input: { url: 'https://docs.anthropic.com/en/docs/overview' },
    result: `# Claude API Documentation\n\nClaude is a family of AI assistants built by Anthropic.\n\n## Getting Started\n\nTo use the Claude API, you'll need an API key.\n\n### Authentication\n\nPass your key via the \`x-api-key\` header.\n\n\`\`\`bash\ncurl https://api.anthropic.com/v1/messages -H "x-api-key: $KEY"\n\`\`\``,
    toolType: 'WebFetch',
  },
};
