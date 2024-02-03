import { defineMiddleware } from "astro:middleware";

export type Suspended = { read: () => string };
type SuspendedChunk = Suspended & { promise: Promise<void> };

export const onRequest = defineMiddleware(async (ctx, next) => {
  const response = await next();
  // ignore non-HTML responses
  if (!response.headers.get("content-type")?.startsWith("text/html")) {
    return response;
  }

  ctx.locals.suspended = [];

  async function* render() {
    // @ts-expect-error ReadableStream does not have asyncIterator
    for await (const chunk of response.body) {
      yield chunk;
    }

    // Thank you owoce!
    // https://gist.github.com/lubieowoce/05a4cb2e8cd252787b54b7c8a41f09fc
    const stream = new ReadableStream<{ chunk: string; idx: number }>({
      start(controller) {
        const suspended = ctx.locals.suspended;

        let done = 0;
        const processPromise = async (
          promise: Promise<string>,
          idx: number
        ) => {
          console.log("middleware :: scheduling promise", idx);
          try {
            const chunk = await promise;
            console.log("middleware :: finished promise", idx);
            controller.enqueue({ chunk, idx });
          } catch (e) {
            controller.error(e);
            return;
          }
          done++;
          if (done >= suspended.length) {
            controller.close();
          }
        };
        suspended.forEach(processPromise);

        // catch promises added after we ran the above.
        suspended.push = function (...promises) {
          const oldLength = suspended.length;
          const ret = Array.prototype.push.call(this, ...promises);
          for (let idx = oldLength; idx < suspended.length; idx++) {
            console.log(
              "middleware :: got a late promise (via patched push)",
              idx
            );
            processPromise(promises[idx], idx);
          }
          return ret;
        };
      },
    });

    // @ts-expect-error ReadableStream does not have asyncIterator
    for await (const { chunk, idx } of stream) {
      yield `<template data-suspense-id=${JSON.stringify(
        idx
      )}>${chunk}</template>
<script>
(() => {
	const template = document.querySelector(\`template[data-suspense-id="${idx}"]\`).content;
	const dest = document.querySelector(\`div[data-suspense-fallback="${idx}"]\`);
	dest.replaceWith(template);
})();
</script>`;
    }
  }

  // @ts-expect-error generator not assignable to ReadableStream
  return new Response(render(), response.headers);
});
