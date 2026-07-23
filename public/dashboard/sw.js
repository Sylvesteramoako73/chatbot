self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "New conversation needs you", body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || "New conversation needs you", {
      body: data.body || "",
      data: { conversationId: data.conversationId },
      tag: data.conversationId, // replaces any existing notification for the same conversation instead of stacking
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var conversationId = event.notification.data && event.notification.data.conversationId;
  var url = conversationId ? "/dashboard/index.html?conversation=" + conversationId : "/dashboard/index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        if (clients[i].url.indexOf("/dashboard/") !== -1 && "focus" in clients[i]) {
          clients[i].navigate(url);
          return clients[i].focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
