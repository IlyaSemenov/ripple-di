/**
 * Test double for a query builder created synchronously but awaitable, such as
 * the ones exposed by SQL builders and ORMs.
 */
export interface QueryBuilder extends PromiseLike<string[]> {
  readonly url: string
}

export function createQueryBuilder(
  url: string,
  onQuery?: () => void,
): QueryBuilder {
  const rows = [`rows from ${url}`]
  return {
    url,
    // biome-ignore lint/suspicious/noThenProperty: the awaitable value is the subject under test.
    then: (onfulfilled) => {
      onQuery?.()
      return Promise.resolve(rows).then(onfulfilled)
    },
  }
}
