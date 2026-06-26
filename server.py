import http.server
import webbrowser
import threading

# Define the HTTP request handler class
class MyHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        super().do_GET()
        self.server.stop = True  # Signal to stop the server after serving the request

# Create a simple HTTP server on port 3000
server_address = ('', 3000)
httpd = http.server.HTTPServer(server_address, MyHttpRequestHandler)
httpd.stop = False

# Open the web browser to view the server
url = 'http://localhost:3000'
webbrowser.open_new_tab(url)

# Start serving the requests in a separate thread
server_thread = threading.Thread(target=httpd.serve_forever)
server_thread.daemon = True
server_thread.start()
while 1:
    pass
# Wait until the server is stopped
while not httpd.stop:
    pass

# Clean up and close the server
httpd.server_close()
