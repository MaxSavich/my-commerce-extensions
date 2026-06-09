const { defineConfig } = require("@adobe/aio-commerce-lib-app/config");

module.exports = defineConfig({
  metadata: {
    id: "commerce-oop-ms",
    displayName: "Commerce OOP MS",
    version: "1.0.0",
    description:
      "A custom Adobe Commerce application. Fill description for your app.",
  },
  eventing: {
    commerce: [
      {
        provider: {
          label: "Commerce Events Provider",
          description: "A description for your Commerce Events provider.",
        },
        events: [
          {
            name: "plugin.sample_event",
            fields: [{ name: "*" }],
            label: "Sample Event",
            description: "Use case description for the event.",
            runtimeActions: ["my-package/handle-sample-event"],
          },
        ],
      },
    ],
  },
  webhooks: [
    {
      label: "Sample Webhook",
      description: "A sample Commerce Webhook handler.",
      runtimeAction: "my-package/handle-webhook",
      category: "modification",
      webhook: {
        webhook_method: "plugin.sample.event",
        webhook_type: "after",
        batch_name: "my_app",
        hook_name: "sample_hook",
        method: "POST",
      },
    },
    {
      label: "Sample Webhook with URL",
      description: "A sample Commerce Webhook handler using an explicit URL.",
      category: "modification",
      webhook: {
        webhook_method: "plugin.sample.event",
        webhook_type: "after",
        batch_name: "my_app",
        hook_name: "sample_hook_url",
        method: "POST",
        url: "https://example.com/webhook",
      },
    },
  ],
});
