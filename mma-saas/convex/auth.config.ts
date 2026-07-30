// Named rather than exported as an anonymous object literal purely to satisfy
// import/no-anonymous-default-export. Convex reads the default export, and a
// named const changes nothing about that.
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
