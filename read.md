README.md
Online Cafeteria Management System
This project is an Online Cafeteria Management System built using Node.js, Express, MongoDB, and integrates with Stripe for handling payments. It allows admins to manage menus, tables, and orders, while customers can browse the menu, reserve tables, place orders, and pay bills.

Table of Contents
Installation
Usage
Features
Routes
Tech Stack
Installation
Clone the repository:

bash
Copy code
git clone <repository_url>
Install dependencies:

bash
Copy code
npm install
Set up MongoDB and configure your connection string in index.js.

Set up environment variables:

STRIPE_SECRET_KEY: Your Stripe secret key.
Run the application:

bash
Copy code
node index.js
Usage
Admin can log in to manage menus, view orders, approve payments, and handle table reservations.
Customers can browse the menu, add items to their cart, reserve tables, and place orders.
Features
Admin Panel: Menu, orders, and user management.
Customer Panel: Browse menu, order food, reserve tables, and make payments.
Stripe Integration: Secure payments for table reservations and order payments.
Routes
Public Routes
Method	Route	Description
GET	/	Home page
GET	/login	Login page
POST	/login	Login action
GET	/register	Registration page
POST	/register	Register action
GET	/logout	Logout action
Admin Routes
Method	Route	Description
GET	/admin/menu	Display admin menu management page
POST	/admin/menu	Add a new menu item
GET	/admin/menu/:id/edit	Display edit form for a menu item
POST	/admin/menu/:id/edit	Edit a menu item
GET	/admin/menu/:id/delete	Delete a menu item
POST	/admin/menu/:id/toggle-availability	Toggle menu item availability
GET	/admin/orders	View all orders
POST	/admin/orders/:id/update-status	Update order status
POST	/admin/orders/:id/confirm-offline-payment	Confirm offline payment
GET	/admin/users	Manage users
GET	/admin/users/:id/delete	Delete a user
GET	/tables/new	Add a new table
POST	/tables/new	Add new table action
Customer Routes
Method	Route	Description
GET	/customer/menu	Display the customer menu
POST	/cart/add	Add item to cart
GET	/cart/view	View cart
POST	/cart/update	Update cart item
GET	/cart/remove/:id	Remove item from cart
POST	/orders/place	Place an order
GET	/customer/orders	View customer's orders
POST	/customer/tables/reserve/pay	Pay to reserve a table
POST	/customer/tables/reserve/confirm	Confirm reservation after payment
Tech Stack
Node.js
Express
MongoDB
Stripe
EJS
Socket.io