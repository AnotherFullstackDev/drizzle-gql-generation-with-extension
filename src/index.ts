import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import * as dbSchema from "./db/schema.js";
import { buildSchema } from "drizzle-graphql";
import { createYoga } from "graphql-yoga";
import { createMiddleware } from "hono/factory";
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
} from "graphql";

const db = drizzle(process.env.DATABASE_URL!, { schema: dbSchema });

const { entities } = buildSchema(db);

// In order to reuse GQL ObjectType it is mandatory not to do premature optimisation!
// The nested objects resolution has to happen in their resolvers so the parent query does not have to return all the data graph.
const PostObjectType = new GraphQLObjectType({
  name: "Post",
  fields: {
    ...entities.types.PostsTableSelectItem.toConfig().fields,
    comments: {
      type: new GraphQLList(entities.types.CommentsTableSelectItem),
      resolve: async (source, args, context, info) => {
        return db.query.commentsTable.findMany({
          where: (comments, { eq }) => eq(comments.postId, source.id),
        });
      },
    },
  },
});

// Usage of the shared input type for filtering might make the composition of where clauses for parent objects easier.
// It is possible just to reuse the same input type for filtering both, the parent and nested objects.
const WherePostsInputType = new GraphQLInputObjectType({
  name: "WherePostsInput",
  fields: {
    id: { type: GraphQLInt },
  },
});

const UserObjectType = new GraphQLObjectType({
  name: "User",
  fields: {
    ...entities.types.UsersTableItem.toConfig().fields,
    posts: {
      type: new GraphQLList(new GraphQLNonNull(PostObjectType)),
      args: {
        where: { type: WherePostsInputType },
      },
      resolve: async (source, args, context, info) => {
        return db.query.postsTable.findMany({
          where: (posts, { eq, and }) =>
            and(
              eq(posts.userId, source.id),
              args.where ? eq(posts.id, args.where.id) : undefined,
            ),
        });
      },
    },
  },
});

const customGqlSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: "Query",
    fields: {
      ...entities.queries,
      users: {
        type: new GraphQLList(new GraphQLNonNull(UserObjectType)),
        args: {
          where: {
            type: new GraphQLInputObjectType({
              name: "WhereUserPostsInput",
              fields: {
                posts: { type: WherePostsInputType },
              },
            }),
          },
        },
        resolve: async (source, args, context, info) => {
          console.log(args);
          return db.query.usersTable.findMany({
            where: (users, { eq, and, exists }) =>
              exists(
                db
                  .select({ userId: dbSchema.postsTable.userId })
                  .from(dbSchema.postsTable)
                  .where((posts) =>
                    and(
                      eq(posts.userId, users.id),
                      args.where && args.where.posts
                        ? eq(dbSchema.postsTable.id, args.where.posts.id)
                        : undefined,
                    ),
                  ),
              ),
          });
        },
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: "Mutation",
    fields: {
      ...entities.mutations,
    },
  }),
});

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Hono!");
});

app.use(
  "/graphql",
  createMiddleware(async (c) => {
    const yoga = createYoga({
      schema: customGqlSchema,
      graphqlEndpoint: c.req.path,
    });

    const response = await yoga.handle(c.req.raw);
    // @ts-expect-error
    response.status = 200;
    // @ts-expect-error
    response.statusText = "OK";

    return response;
  }),
);

const port = 3000;
console.log(`Server is running on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});
