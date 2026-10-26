export const PRS_QUERY = `
  query($owner: String!, $repo: String!, $states: [PullRequestState!]!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 100, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          author { login __typename }
          createdAt
          updatedAt
          closedAt
          additions
          deletions
          changedFiles
          headRefOid
          labels(first: 20) { nodes { name } }
          closingIssuesReferences(first: 100) { totalCount nodes { number repository { nameWithOwner } } }
          reviews { totalCount }
          files(first: 100) { totalCount nodes { path } }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
  }
`;

export const ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $states: [IssueState!]!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, after: $cursor, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          title
          body
          state
          author { login __typename }
          createdAt
          updatedAt
          closedAt
          labels(first: 20) { nodes { name } }
        }
      }
    }
  }
`;

export const AUTHOR_MERGE_COUNT_QUERY = `
  query($q: String!) {
    search(query: $q, type: ISSUE, first: 0) { issueCount }
  }
`;
