// App settings and env vars are snapshotted when a deployment is triggered,
// so a change does nothing to the running app until the next one. Which tool
// applies it matters: env vars and runtime settings are not build inputs, so
// redeploying the existing image is enough, while trigger_deployment runs a
// full build for a Git app. Agents default to the latter unless told otherwise.
export const REDEPLOY_NOTE =
  "Takes effect on the next deployment. This change does not need a new build: apply it with redeploy_deployment on the app's live deployment (get_app's liveDeployment.id), which reuses the built image. If liveDeployment is null, redeploy the latest deployment that has a built image. Only use trigger_deployment if the app has no deployment with a built image yet."
export const REBUILD_NOTE =
  "Takes effect on the next deployment. This changes what the app is built or run from, so call trigger_deployment to apply it."
