self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    const window = windows.find((item) => new URL(item.url).origin === self.location.origin);
    return window ? window.focus().then(() => window.navigate(url)) : clients.openWindow(url);
  }));
});
